import { describe, expect, it } from 'vitest';
import { CliError, EXIT } from '../src/errors.ts';
import {
  CLI_CLIENT_ID,
  DEVICE_GRANT_TYPE,
  discoverResource,
  formatUserCode,
  GrantEndedError,
  isLoopbackHost,
  isLostRefresh,
  pollDeviceToken,
  refreshTokens,
  revokeToken,
  startDeviceAuthorization,
} from '../src/oauth.ts';

const SERVER = 'https://rooster.test';
const RESOURCE = `${SERVER}/api/v1`;

interface Sent {
  path: string;
  body: Record<string, string>;
  contentType: string | null;
}

/** A scripted authorization server: each answer in turn, recording what was sent. */
function scripted(answers: (Response | (() => Response))[]) {
  const sent: Sent[] = [];
  const send = async (request: Request) => {
    sent.push({
      path: new URL(request.url).pathname,
      body: Object.fromEntries(new URLSearchParams(await request.text())),
      contentType: request.headers.get('content-type'),
    });
    const next = answers.shift();
    if (next === undefined) throw new Error('unexpected request');
    return typeof next === 'function' ? next() : next;
  };
  return { send, sent };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const tokens = (n: number) => ({
  access_token: `rooster_at_${n}`,
  refresh_token: `rooster_rt_${n}`,
  token_type: 'Bearer',
  expires_in: 900,
  scope: 'tasks:read tasks:write offline_access',
});

/** A clock that only moves when the code sleeps. */
function fakeClock() {
  let now = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}

const AUTH = {
  deviceCode: 'd'.repeat(43),
  userCode: 'KXRT49WM',
  verificationUri: `${SERVER}/device`,
  expiresIn: 600,
  interval: 5,
};

async function failure(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error('expected a CliError');
}

describe('device authorization (RFC 8628 §3.1–3.2)', () => {
  it('posts form-encoded client_id, scope and exactly one resource', async () => {
    const { send, sent } = scripted([
      json({
        device_code: AUTH.deviceCode,
        user_code: 'KXRT-49WM',
        verification_uri: `${SERVER}/device`,
        expires_in: 600,
        interval: 7,
      }),
    ]);
    const result = await startDeviceAuthorization(send, SERVER, {
      scopes: ['tasks:read', 'tasks:write'],
      resource: RESOURCE,
    });
    expect(sent[0]).toEqual({
      path: '/api/auth/oauth2/device-authorization',
      body: { client_id: CLI_CLIENT_ID, scope: 'tasks:read tasks:write', resource: RESOURCE },
      contentType: 'application/x-www-form-urlencoded',
    });
    expect(result).toEqual({
      kind: 'grant',
      authorization: {
        deviceCode: AUTH.deviceCode,
        userCode: 'KXRT-49WM',
        verificationUri: `${SERVER}/device`,
        expiresIn: 600,
        interval: 7,
      },
    });
  });

  it('an older server (404/405) or unauthorized_client means the legacy flow', async () => {
    for (const answer of [
      new Response('Not Found', { status: 404 }),
      new Response(null, { status: 405 }),
      json({ error: 'unauthorized_client' }, 400),
      json({ error: 'unauthorized_client' }, 401),
    ]) {
      const { send } = scripted([answer]);
      expect(
        await startDeviceAuthorization(send, SERVER, {
          scopes: ['tasks:read'],
          resource: RESOURCE,
        }),
      ).toEqual({ kind: 'unsupported' });
    }
  });

  it('other errors fail the login with the plain error code, never server text', async () => {
    const { send } = scripted([
      json({ error: 'invalid_target', error_description: '\u001b]52;c;AAAA\u0007' }, 400),
    ]);
    const error = await failure(
      startDeviceAuthorization(send, SERVER, { scopes: ['tasks:read'], resource: RESOURCE }),
    );
    expect(error.exitCode).toBe(EXIT.auth);
    expect(error.message).toContain('invalid_target');
    expect(error.message).not.toContain('\u001b');
  });

  it('a hostile user code or a missing device code is refused', async () => {
    for (const body of [
      { device_code: AUTH.deviceCode, user_code: 'AB\u001b[2J', verification_uri: 'x' },
      { device_code: 'short', user_code: 'KXRT49WM', verification_uri: 'x' },
      { user_code: 'KXRT49WM', verification_uri: 'x' },
    ]) {
      const { send } = scripted([json(body)]);
      const error = await failure(
        startDeviceAuthorization(send, SERVER, { scopes: ['tasks:read'], resource: RESOURCE }),
      );
      expect(error.message).toContain('invalid_device_response');
    }
  });

  it('bounds the timing a server asks for', async () => {
    const { send } = scripted([
      json({
        device_code: AUTH.deviceCode,
        user_code: 'KXRT49WM',
        verification_uri: 'x',
        expires_in: 10 ** 9,
        interval: 0,
      }),
    ]);
    const result = await startDeviceAuthorization(send, SERVER, {
      scopes: ['tasks:read'],
      resource: RESOURCE,
    });
    expect(result.kind === 'grant' && result.authorization).toMatchObject({
      expiresIn: 1800,
      interval: 1,
    });
  });

  it('formats the user code as XXXX-XXXX (11 §9.2)', () => {
    expect(formatUserCode('kxrt49wm')).toBe('KXRT-49WM');
    expect(formatUserCode('KXRT-49WM')).toBe('KXRT-49WM');
    expect(formatUserCode('ABC-DEF')).toBe('ABC-DEF');
  });
});

describe('polling the token endpoint (RFC 8628 §3.4–3.5)', () => {
  it('waits the interval, adds 5 s after slow_down for good, and returns the tokens', async () => {
    const clock = fakeClock();
    const { send, sent } = scripted([
      json({ error: 'authorization_pending' }, 400),
      json({ error: 'slow_down' }, 400),
      json({ error: 'authorization_pending' }, 400),
      json({ error: 'slow_down' }, 400),
      json(tokens(1)),
    ]);
    const result = await pollDeviceToken(send, SERVER, AUTH, RESOURCE, clock);
    expect(clock.sleeps).toEqual([5000, 5000, 10000, 10000, 15000]);
    expect(sent.every((s) => s.path === '/api/auth/oauth2/token')).toBe(true);
    expect(sent[0]?.body).toEqual({
      grant_type: DEVICE_GRANT_TYPE,
      device_code: AUTH.deviceCode,
      client_id: CLI_CLIENT_ID,
      resource: RESOURCE,
    });
    expect(result).toEqual({
      accessToken: 'rooster_at_1',
      refreshToken: 'rooster_rt_1',
      expiresAt: 1_000_000 + 45_000 + 900_000,
      scopes: ['tasks:read', 'tasks:write'],
    });
  });

  it('the interval comes from the server', async () => {
    const clock = fakeClock();
    const { send } = scripted([json({ error: 'authorization_pending' }, 400), json(tokens(1))]);
    await pollDeviceToken(send, SERVER, { ...AUTH, interval: 2 }, RESOURCE, clock);
    expect(clock.sleeps).toEqual([2000, 2000]);
  });

  it('access_denied and expired_token exit 3', async () => {
    for (const [error, text] of [
      ['access_denied', 'denied'],
      ['expired_token', 'expired'],
    ] as const) {
      const { send } = scripted([json({ error }, 400)]);
      const failed = await failure(pollDeviceToken(send, SERVER, AUTH, RESOURCE, fakeClock()));
      expect(failed.exitCode).toBe(EXIT.auth);
      expect(failed.message).toContain(text);
    }
  });

  it('gives up when the code has expired', async () => {
    const pending = () => json({ error: 'authorization_pending' }, 400);
    const { send, sent } = scripted(Array.from({ length: 200 }, () => pending));
    const failed = await failure(
      pollDeviceToken(send, SERVER, { ...AUTH, expiresIn: 20 }, RESOURCE, fakeClock()),
    );
    expect(failed.message).toContain('expired');
    expect(sent).toHaveLength(4);
  });

  it('a server error is exit 6; a malformed success is refused', async () => {
    const { send } = scripted([json({ error: 'server_error' }, 503)]);
    expect(
      (await failure(pollDeviceToken(send, SERVER, AUTH, RESOURCE, fakeClock()))).exitCode,
    ).toBe(EXIT.network);
    for (const body of [
      { ...tokens(1), access_token: 'has space' },
      { ...tokens(1), refresh_token: undefined },
      { ...tokens(1), token_type: 'DPoP' },
    ]) {
      const bad = scripted([json(body)]);
      const failed = await failure(pollDeviceToken(bad.send, SERVER, AUTH, RESOURCE, fakeClock()));
      expect(failed.message).toContain('invalid_token_response');
    }
  });
});

describe('refresh and revocation', () => {
  it('rotates: sends the refresh token, client and resource; returns the new pair', async () => {
    const { send, sent } = scripted([json(tokens(2))]);
    const result = await refreshTokens(send, SERVER, 'rooster_rt_1', RESOURCE, () => 5);
    expect(sent[0]?.body).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'rooster_rt_1',
      client_id: CLI_CLIENT_ID,
      resource: RESOURCE,
    });
    expect(result).toMatchObject({
      accessToken: 'rooster_at_2',
      refreshToken: 'rooster_rt_2',
      expiresAt: 900_005,
    });
  });

  it('keeps the refresh token when none is rotated in', async () => {
    const { send } = scripted([json({ ...tokens(2), refresh_token: undefined })]);
    const result = await refreshTokens(send, SERVER, 'rooster_rt_1', RESOURCE, () => 0);
    expect(result.refreshToken).toBe('rooster_rt_1');
  });

  it('invalid_grant (revoked, expired or reused) is GrantEndedError; 5xx is exit 6', async () => {
    const ended = scripted([json({ error: 'invalid_grant' }, 400)]);
    await expect(
      refreshTokens(ended.send, SERVER, 'rooster_rt_1', RESOURCE, () => 0),
    ).rejects.toBeInstanceOf(GrantEndedError);
    const down = scripted([new Response('', { status: 502 })]);
    expect(
      (await failure(refreshTokens(down.send, SERVER, 'rooster_rt_1', RESOURCE, () => 0))).exitCode,
    ).toBe(EXIT.network);
  });

  it('a body cut off after a 200 is a lost answer (exit 6, retried), never a malformed one', async () => {
    const cut = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"access_token":'));
            controller.error(new TypeError('terminated'));
          },
        }),
        { status: 200 },
      );
    const refresh = scripted([cut]);
    const error = await failure(
      refreshTokens(refresh.send, SERVER, 'rooster_rt_1', RESOURCE, () => 0),
    );
    expect(error.exitCode).toBe(EXIT.network);
    expect(isLostRefresh(error)).toBe(true);
    // A complete body that isn't JSON is still a malformed answer, not a lost one.
    const garbage = scripted([new Response('<html>', { status: 200 })]);
    const malformed = await failure(
      refreshTokens(garbage.send, SERVER, 'rooster_rt_1', RESOURCE, () => 0),
    );
    expect(malformed.message).toContain('invalid_token_response');
    expect(isLostRefresh(malformed)).toBe(false);
    // The device poll: exit 6 too (the code redeems once, so a new login is needed).
    const poll = scripted([cut]);
    expect(
      (await failure(pollDeviceToken(poll.send, SERVER, AUTH, RESOURCE, fakeClock()))).exitCode,
    ).toBe(EXIT.network);
  });

  it('a cut-off body keeps the class of its status: only a 2xx or a 5xx is lost', async () => {
    const cut = (status: number) => () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"error":"inv'));
            controller.error(new TypeError('terminated'));
          },
        }),
        { status },
      );
    for (const [status, exit, lost] of [
      [400, EXIT.auth, false],
      [401, EXIT.auth, false],
      [403, EXIT.auth, false],
      [429, EXIT.network, false],
      [503, EXIT.network, true],
      [200, EXIT.network, true],
    ] as const) {
      const { send } = scripted([cut(status)]);
      const error = await failure(refreshTokens(send, SERVER, 'rooster_rt_1', RESOURCE, () => 0));
      expect([status, error.exitCode, isLostRefresh(error)]).toEqual([status, exit, lost]);
    }
  });

  it('revokes the refresh token (RFC 7009) without a resource', async () => {
    const { send, sent } = scripted([new Response(null, { status: 200 })]);
    expect(await revokeToken(send, SERVER, 'rooster_rt_1')).toBe(true);
    expect(sent[0]).toMatchObject({
      path: '/api/auth/oauth2/revoke',
      body: { token: 'rooster_rt_1', token_type_hint: 'refresh_token', client_id: CLI_CLIENT_ID },
    });
    const refused = scripted([json({ error: 'invalid_client' }, 401)]);
    expect(await revokeToken(refused.send, SERVER, 'rooster_rt_1')).toBe(false);
  });
});

describe('resource discovery (RFC 9728)', () => {
  const prm = (resource: unknown, status = 200) =>
    scripted([json({ resource, authorization_servers: [] }, status)]);

  it("takes the server's canonical resource for the audience", async () => {
    const api = prm('https://tasks.example.com/api/v1');
    expect(await discoverResource(api.send, SERVER, 'api')).toBe(
      'https://tasks.example.com/api/v1',
    );
    expect(api.sent[0]?.path).toBe('/.well-known/oauth-protected-resource/api/v1');
    const mcp = prm('http://localhost:3000/mcp');
    expect(await discoverResource(mcp.send, SERVER, 'mcp')).toBe('http://localhost:3000/mcp');
    expect(mcp.sent[0]?.path).toBe('/.well-known/oauth-protected-resource/mcp');
  });

  it('falls back to <server>/api/v1 for anything else', async () => {
    for (const resource of [
      'http://tasks.example.com/api/v1',
      'https://tasks.example.com/mcp',
      'https://u:p@tasks.example.com/api/v1',
      'https://tasks.example.com/api/v1?x=1',
      'javascript:alert(1)//api/v1',
      42,
    ]) {
      expect(await discoverResource(prm(resource).send, SERVER, 'api')).toBe(RESOURCE);
    }
    expect(await discoverResource(prm('x', 404).send, SERVER, 'api')).toBe(RESOURCE);
    const offline = async () => {
      throw new CliError(EXIT.network, 'down');
    };
    expect(await discoverResource(offline, SERVER, 'mcp')).toBe(`${SERVER}/mcp`);
  });

  it('knows loopback hosts', () => {
    for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '[::1]']) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of ['localhost.evil.test', '10.0.0.1', '128.0.0.1']) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});
