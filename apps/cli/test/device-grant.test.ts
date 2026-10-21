import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { profileLockPath } from '../src/profile-lock.ts';
import { FAKE_ENV, fakeApi } from './support/fake-api.ts';
import { type CliHarness, cliHarness } from './support/fake-io.ts';
import { fakeOAuth } from './support/fake-oauth.ts';
import { serveFetch } from './support/server.ts';

const SERVER = 'https://rooster.test';
const CLI_DIR = join(import.meta.dirname, '..');

let cli: CliHarness | undefined;
afterEach(() => {
  cli?.cleanup();
  cli = undefined;
});

function harness(oauth: ReturnType<typeof fakeOAuth>): CliHarness {
  cli = cliHarness({}, { fetch: oauth.fetch, sleep: async () => {} });
  return cli;
}

/** The credential files of the home (ROOSTER_KEYRING=off). */
function storedSecrets(home: string): Record<string, unknown>[] {
  const dir = join(home, 'config', 'rooster', 'credentials.d');
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')));
}

async function login(h: CliHarness, extra: string[] = []) {
  return h.run(['login', '--server', SERVER, ...extra]);
}

describe('AC-12.4 rooster login on the device grant', () => {
  it('asks with resource=<server>/api/v1, shows the formatted code, opens /device bare, stores the rotating tokens', async () => {
    const oauth = fakeOAuth();
    const h = harness(oauth);
    const run = await login(h, ['--scope', 'tasks:read']);
    expect(run.code).toBe(0);
    expect(oauth.state.deviceRequests[0]).toEqual({
      client_id: 'rooster-cli',
      scope: 'tasks:read',
      resource: `${SERVER}/api/v1`,
    });
    expect(run.stdout).toContain('Code: KXRT-49WM');
    expect(run.stderr).toContain(`open ${SERVER}/device`);
    expect(run.stderr).toContain('Signed in as Ada');
    // Neither token is ever printed.
    expect(`${run.stdout}${run.stderr}`).not.toMatch(/rooster_(at|rt)_/);
    expect(storedSecrets(h.home)).toEqual([
      {
        v: 2,
        kind: 'oauth',
        token: 'rooster_at_api_1',
        server: SERVER,
        refreshToken: 'rooster_rt_1',
        expiresAt: expect.any(Number),
        audience: 'api',
        resource: `${SERVER}/api/v1`,
        scopes: ['tasks:read', 'tasks:write'],
      },
    ]);
  });

  it('the page is opened without the code (no pre-filled link)', async () => {
    const oauth = fakeOAuth();
    const opened: string[] = [];
    cli = cliHarness(
      {},
      {
        fetch: oauth.fetch,
        sleep: async () => {},
        openUrl: async (href) => {
          opened.push(href);
          return true;
        },
      },
    );
    expect((await login(cli)).code).toBe(0);
    expect(opened).toEqual([`${SERVER}/device`]);
  });

  it('refreshes an access token about to expire, once, and stores the rotated pair', async () => {
    const oauth = fakeOAuth({ loginExpiresIn: 30 });
    const h = harness(oauth);
    expect((await login(h)).code).toBe(0);
    const who = await h.run(['whoami', '--quiet']);
    expect(who.code).toBe(0);
    expect(who.stdout).toBe('ada@example.com\n');
    expect(oauth.state.refreshes).toBe(1);
    expect(oauth.state.refreshRequests[0]).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'rooster_rt_1',
      client_id: 'rooster-cli',
      resource: `${SERVER}/api/v1`,
    });
    expect(storedSecrets(h.home)[0]).toMatchObject({
      token: 'rooster_at_api_2',
      refreshToken: 'rooster_rt_2',
    });
    expect(oauth.state.bearers.at(-1)).toBe('Bearer rooster_at_api_2');
    // Fresh now: the next command refreshes nothing.
    expect((await h.run(['whoami', '--quiet'])).code).toBe(0);
    expect(oauth.state.refreshes).toBe(1);
  });

  it('concurrent commands in one process share one refresh (no reuse, the grant survives)', async () => {
    const oauth = fakeOAuth({ loginExpiresIn: 30, refreshDelayMs: 40 });
    const h = harness(oauth);
    expect((await login(h)).code).toBe(0);
    const runs = await Promise.all([1, 2, 3].map(() => h.run(['whoami', '--quiet'])));
    expect(runs.map((r) => r.code)).toEqual([0, 0, 0]);
    expect(oauth.state.refreshes).toBe(1);
    expect(oauth.state.reused).toBe(false);
  });

  it('AC-12.4 concurrent rooster processes refresh once between them; the grant is not revoked', async () => {
    const oauth = fakeOAuth({ loginExpiresIn: 30, refreshDelayMs: 1500 });
    const served = await serveFetch(oauth.handler);
    cli = cliHarness({}, { sleep: async () => {} });
    try {
      expect((await cli.run(['login', '--no-browser', '--server', served.url])).code).toBe(0);
      const env = {
        PATH: process.env.PATH ?? '',
        HOME: cli.home,
        XDG_CONFIG_HOME: join(cli.home, 'config'),
        XDG_STATE_HOME: join(cli.home, 'state'),
        XDG_CACHE_HOME: join(cli.home, 'cache'),
        ROOSTER_KEYRING: 'off',
        LANG: 'en_US.UTF-8',
      };
      const results = await Promise.all(
        [1, 2, 3].map(
          () =>
            new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
              const child = spawn(
                process.execPath,
                ['--import', 'tsx', join(CLI_DIR, 'src/main.ts'), 'whoami', '--quiet'],
                { cwd: CLI_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] },
              );
              let out = '';
              let err = '';
              child.stdout.on('data', (d: Buffer) => {
                out += d.toString();
              });
              child.stderr.on('data', (d: Buffer) => {
                err += d.toString();
              });
              child.on('exit', (code) => resolve({ code, out, err }));
            }),
        ),
      );
      for (const result of results) {
        expect(result.err).toBe('');
        expect(result.code).toBe(0);
        expect(result.out).toBe('ada@example.com\n');
      }
      expect(oauth.state.refreshes).toBe(1);
      expect(oauth.state.reused).toBe(false);
      expect(oauth.state.revoked).toBe(false);
    } finally {
      await served.close();
    }
  }, 60_000);

  it('a refresh whose answer was lost is sent again at once and stores the second pair', async () => {
    for (const lostAs of ['network', 'status', 'body'] as const) {
      const oauth = fakeOAuth({ loginExpiresIn: 30, loseRefreshResponses: 1, lostAs });
      const sleeps: number[] = [];
      cli = cliHarness(
        {},
        {
          fetch: oauth.fetch,
          sleep: async (ms) => {
            sleeps.push(ms);
          },
        },
      );
      expect((await login(cli)).code).toBe(0);
      sleeps.length = 0;
      const who = await cli.run(['whoami', '--quiet']);
      expect(who.stderr).toBe('');
      expect(who.code).toBe(0);
      // The same refresh token twice: the second redeemed in the server's grace period.
      expect(oauth.state.refreshRequests.map((r) => r.refresh_token)).toEqual([
        'rooster_rt_1',
        'rooster_rt_1',
      ]);
      expect(sleeps).toEqual([1000]);
      expect(oauth.state.graceRedemptions).toBe(1);
      expect(oauth.state.revoked).toBe(false);
      expect(storedSecrets(cli.home)[0]).toMatchObject({
        token: 'rooster_at_api_3',
        refreshToken: 'rooster_rt_3',
      });
      // The grant lives on: the next refresh uses the stored pair.
      expect(oauth.state.bearers.at(-1)).toBe('Bearer rooster_at_api_3');
      cli.cleanup();
      cli = undefined;
    }
  });

  it('a refused refresh (invalid_grant, a 4xx, a 429) is never sent again', async () => {
    for (const setup of [
      (o: ReturnType<typeof fakeOAuth>) => {
        o.state.revoked = true;
      },
      undefined,
    ]) {
      const oauth = fakeOAuth({ loginExpiresIn: 30 });
      const h = harness(oauth);
      expect((await login(h)).code).toBe(0);
      if (setup) setup(oauth);
      else oauth.state.spentRefresh.add('rooster_rt_1');
      const run = await h.run(['whoami']);
      expect(run.code).toBe(3);
      expect(oauth.state.refreshRequests).toHaveLength(1);
      h.cleanup();
      cli = undefined;
    }
    for (const status of [400, 429]) {
      const oauth = fakeOAuth({ loginExpiresIn: 30, refreshStatus: status });
      const h = harness(oauth);
      expect((await login(h)).code).toBe(0);
      const run = await h.run(['whoami']);
      expect(run.code).toBe(status === 429 ? 6 : 3);
      expect(oauth.state.refreshRequests).toHaveLength(1);
      h.cleanup();
      cli = undefined;
    }
  });

  it('a second lost answer is an error, after exactly one retry', async () => {
    const oauth = fakeOAuth({ loginExpiresIn: 30, loseRefreshResponses: 2 });
    const h = harness(oauth);
    expect((await login(h)).code).toBe(0);
    const run = await h.run(['whoami']);
    expect(run.code).toBe(6);
    expect(oauth.state.refreshRequests).toHaveLength(2);
    // Nothing new was stored: the stored login is still the first one.
    expect(storedSecrets(h.home)[0]).toMatchObject({ refreshToken: 'rooster_rt_1' });
  });

  it.skipIf(process.getuid?.() === 0)(
    'tokens that can’t be stored leave the previous login untouched; a rerun redeems it in the grace period',
    async () => {
      const oauth = fakeOAuth({ loginExpiresIn: 30 });
      const h = harness(oauth);
      expect((await login(h)).code).toBe(0);
      const dir = join(h.home, 'config', 'rooster', 'credentials.d');
      const [before] = readdirSync(dir).map((name) => readFileSync(join(dir, name), 'utf8'));
      chmodSync(dir, 0o500);
      let failed: { code: number; stderr: string; stdout: string };
      try {
        failed = await h.run(['whoami']);
      } finally {
        chmodSync(dir, 0o700);
      }
      expect(failed.code).toBe(3);
      expect(failed.stderr).toContain('The previous login was kept');
      expect(failed.stderr).not.toMatch(/rooster_(at|rt)_/);
      expect(readdirSync(dir).map((name) => readFileSync(join(dir, name), 'utf8'))).toEqual([
        before,
      ]);
      // The rerun sends the kept refresh token, which the server redeems once more.
      const rerun = await h.run(['whoami', '--quiet']);
      expect(rerun.code).toBe(0);
      expect(oauth.state.graceRedemptions).toBe(1);
      expect(oauth.state.revoked).toBe(false);
    },
  );

  it('a lock left behind by a dead process does not stop the refresh', async () => {
    const oauth = fakeOAuth({ loginExpiresIn: 30 });
    const h = harness(oauth);
    expect((await login(h)).code).toBe(0);
    const lock = profileLockPath(join(h.home, 'config', 'rooster'), 'default');
    mkdirSync(dirname(lock), { recursive: true });
    // A pid far above any real one on this host: gone.
    writeFileSync(
      lock,
      JSON.stringify({ pid: 2 ** 30, host: hostname(), at: Date.now(), id: 'x' }),
    );
    expect((await h.run(['whoami', '--quiet'])).code).toBe(0);
    expect(oauth.state.refreshes).toBe(1);
  });

  it('a revoked or reused grant exits 3 and asks for a new login; nothing secret is printed', async () => {
    const oauth = fakeOAuth({ loginExpiresIn: 30 });
    const h = harness(oauth);
    expect((await login(h)).code).toBe(0);
    oauth.state.revoked = true;
    const run = await h.run(['whoami']);
    expect(run.code).toBe(3);
    expect(run.stderr).toContain('rooster login --profile default');
    expect(run.stdout).toBe('');
    expect(run.stderr).not.toMatch(/rooster_(at|rt)_/);
  });

  it('logout revokes the refresh token (RFC 7009) and removes the login', async () => {
    const oauth = fakeOAuth();
    const h = harness(oauth);
    expect((await login(h)).code).toBe(0);
    const out = await h.run(['logout', '--json']);
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ revoked: true });
    expect(oauth.state.revocations).toEqual([
      { token: 'rooster_rt_1', token_type_hint: 'refresh_token', client_id: 'rooster-cli' },
    ]);
    expect(storedSecrets(h.home)).toEqual([]);
    expect((await h.run(['whoami'])).code).toBe(3);
  });

  it('falls back to the legacy device flow when the server has no device grant for the CLI', async () => {
    for (const answer of [
      () => new Response('Not Found', { status: 404 }),
      () => Response.json({ error: 'unauthorized_client' }, { status: 400 }),
    ]) {
      const oauth = fakeOAuth({ deviceAuthorization: answer });
      const legacy = async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === '/api/auth/device/code') {
          return Response.json({
            device_code: 'legacy-device',
            user_code: 'LEGACY12',
            verification_uri: `${SERVER}/device`,
            expires_in: 600,
            interval: 5,
          });
        }
        if (path === '/api/auth/device/token') {
          return Response.json({ access_token: 'legacy-session-token' });
        }
        if (path === '/api/v1/me') return Response.json((await import('./support/fake-api.ts')).ME);
        return oauth.handler(request);
      };
      cli = cliHarness({}, { fetch: legacy as typeof fetch, sleep: async () => {} });
      const run = await login(cli);
      expect(run.code).toBe(0);
      expect(run.stdout).toContain('Code: LEGACY12');
      // The 1.7 format: a bearer session, used as it is.
      expect(storedSecrets(cli.home)).toEqual([{ token: 'legacy-session-token', server: SERVER }]);
      cli.cleanup();
      cli = undefined;
    }
  });

  it('AC-12.4 a 1.7 login (a bearer session) keeps working untouched', async () => {
    const api = fakeApi({ 'GET /api/v1/me': (await import('./support/fake-api.ts')).ME });
    const bearers: string[] = [];
    cli = cliHarness(
      {},
      {
        fetch: (async (request: Request) => {
          bearers.push(request.headers.get('authorization') ?? '');
          return api.fetch(request);
        }) as typeof fetch,
      },
    );
    const home = cli.home;
    const dir = join(home, 'config', 'rooster');
    const ref = '0123456789abcdef0123456789abcdef-01a00000-0000-7000-8000-000000000001';
    mkdirSync(join(dir, 'credentials.d'), { recursive: true });
    writeFileSync(
      join(dir, 'credentials.d', ref),
      `${JSON.stringify({ token: 'session-from-1.7', server: SERVER })}\n`,
    );
    writeFileSync(
      join(dir, 'config.toml'),
      `[profiles.default]\nserver = "${SERVER}"\ncredential_store = "file"\ncredential_ref = "${ref}"\ncredential_origin = "${SERVER}"\n`,
    );
    const who = await cli.run(['whoami', '--quiet']);
    expect(who.code).toBe(0);
    expect(bearers.at(-1)).toBe('Bearer session-from-1.7');
    expect(readFileSync(join(dir, 'credentials.d', ref), 'utf8')).toBe(
      `${JSON.stringify({ token: 'session-from-1.7', server: SERVER })}\n`,
    );
  });
});

describe('AC-12.4 rooster mcp setup --remote and rooster mcp header', () => {
  async function remoteSetup(oauth: ReturnType<typeof fakeOAuth>, extra: string[] = []) {
    const h = harness(oauth);
    const run = await h.run([
      'mcp',
      'setup',
      '--remote',
      '--client',
      'claude-code',
      '--no-browser',
      '--server',
      SERVER,
      ...extra,
    ]);
    return { h, run };
  }

  it('signs the agent profile in for /mcp and prints Claude Code’s add-json with the header helper', async () => {
    const oauth = fakeOAuth({ scope: 'tasks:read tasks:write comments:write' });
    const { h, run } = await remoteSetup(oauth);
    expect(run.code).toBe(0);
    expect(oauth.state.deviceRequests[0]).toMatchObject({
      resource: `${SERVER}/mcp`,
      scope: 'tasks:read tasks:write comments:write notifications:read groups:write',
    });
    const line = run.stdout.split('\n').find((l) => l.startsWith('claude mcp add-json'));
    expect(line).toBeDefined();
    const json = /'(\{.*\})'$/.exec(line ?? '')?.[1];
    const entry = JSON.parse(json ?? 'null') as Record<string, string>;
    expect(Object.keys(entry)).toEqual(['type', 'url', 'headersHelper']);
    expect(entry.type).toBe('http');
    expect(entry.url).toBe(`${SERVER}/mcp`);
    expect(entry.headersHelper).toMatch(/^\/\S+ (\S+ )?mcp header --profile agent$/);
    expect(line).toMatch(/^claude mcp add-json --scope user rooster '/);
    expect(`${run.stdout}${run.stderr}`).not.toMatch(/rooster_(at|rt)_|Bearer/);
    // A remote-only profile, never the default.
    const config = readFileSync(join(h.home, 'config', 'rooster', 'config.toml'), 'utf8');
    expect(config).toContain('[profiles.agent]');
    expect(config).not.toContain('default_profile');
  });

  it('AC-12.4 mcp header prints exactly the Authorization header with a fresh /mcp token', async () => {
    const oauth = fakeOAuth();
    const { h } = await remoteSetup(oauth);
    const header = await h.run(['mcp', 'header']);
    expect(header.code).toBe(0);
    expect(header.stderr).toBe('');
    expect(header.stdout).toBe('{"Authorization":"Bearer rooster_at_mcp_1"}\n');
    expect(JSON.parse(header.stdout)).toEqual({ Authorization: 'Bearer rooster_at_mcp_1' });
    expect(oauth.state.refreshes).toBe(0);
    // `--profile agent` is the same profile; ROOSTER_TOKEN never replaces it.
    const explicit = await h.run(['mcp', 'header', '--profile', 'agent'], {
      env: { ROOSTER_TOKEN: 'rooster_pat_other', ROOSTER_SERVER: 'https://elsewhere.test' },
    });
    expect(explicit.stdout).toBe('{"Authorization":"Bearer rooster_at_mcp_1"}\n');
  });

  it('mcp header refreshes a token with less than five minutes left', async () => {
    const oauth = fakeOAuth({ loginExpiresIn: 240 });
    const { h } = await remoteSetup(oauth);
    const header = await h.run(['mcp', 'header']);
    expect(header.code).toBe(0);
    expect(header.stdout).toBe('{"Authorization":"Bearer rooster_at_mcp_2"}\n');
    expect(oauth.state.refreshRequests[0]?.resource).toBe(`${SERVER}/mcp`);
  });

  it('mcp header fails on stderr with nothing on stdout: an ended grant, an API profile, no login', async () => {
    const oauth = fakeOAuth({ loginExpiresIn: 30 });
    const { h } = await remoteSetup(oauth);
    oauth.state.revoked = true;
    const ended = await h.run(['mcp', 'header']);
    expect(ended.code).toBe(3);
    expect(ended.stdout).toBe('');
    expect(ended.stderr).toContain('rooster mcp setup --remote --relogin');

    expect((await h.run(['login', '--server', SERVER])).code).toBe(0);
    const api = await h.run(['mcp', 'header', '--profile', 'default']);
    expect(api.code).toBe(3);
    expect(api.stdout).toBe('');
    expect(api.stderr).toContain('isn’t signed in for the MCP endpoint');

    const none = await h.run(['mcp', 'header', '--profile', 'nobody']);
    expect(none.code).toBe(3);
    expect(none.stdout).toBe('');
  });

  it('a remote login can’t call the API: ls and the stdio server exit 3 with an explanation', async () => {
    const oauth = fakeOAuth();
    const { h } = await remoteSetup(oauth);
    const ls = await h.run(['ls', '--profile', 'agent']);
    expect(ls.code).toBe(3);
    expect(ls.stderr).toContain('MCP endpoint only');
  });

  it('a rerun reuses the working login; --relogin signs in again', async () => {
    const oauth = fakeOAuth({ scope: 'tasks:read tasks:write' });
    const { h } = await remoteSetup(oauth);
    const again = await h.run(['mcp', 'setup', '--remote', '--client', 'claude-code']);
    expect(again.code).toBe(0);
    expect(again.stderr).toContain('existing login of profile agent');
    expect(oauth.state.deviceRequests).toHaveLength(1);
    const relogin = await h.run([
      'mcp',
      'setup',
      '--remote',
      '--client',
      'claude-code',
      '--relogin',
      '--no-browser',
    ]);
    expect(relogin.code).toBe(0);
    expect(oauth.state.deviceRequests).toHaveLength(2);
  });

  it('replacing a stdio agent login warns that local clients stop working', async () => {
    const oauth = fakeOAuth();
    const h = harness(oauth);
    expect((await h.run(['login', '--server', SERVER, '--profile', 'agent'])).code).toBe(0);
    const run = await h.run([
      'mcp',
      'setup',
      '--remote',
      '--client',
      'print',
      '--no-browser',
      '--server',
      SERVER,
    ]);
    expect(run.code).toBe(0);
    expect(run.stderr).toContain('stop working');
    expect(run.stdout).toContain('"headersHelper"');
    expect(run.stderr).toContain('MCP token');
  });

  it('a server without the device grant for the CLI points to MCP tokens (exit 3)', async () => {
    const oauth = fakeOAuth({
      deviceAuthorization: () => Response.json({ error: 'unauthorized_client' }, { status: 400 }),
    });
    const { run } = await remoteSetup(oauth);
    expect(run.code).toBe(3);
    expect(run.stderr).toContain('--audience mcp');
    expect(run.stdout).not.toContain('claude mcp');
  });

  it('clients without a header helper get MCP tokens explained, and no login', async () => {
    const oauth = fakeOAuth();
    const h = harness(oauth);
    const cursor = await h.run([
      'mcp',
      'setup',
      '--remote',
      '--client',
      'cursor',
      '--server',
      SERVER,
    ]);
    expect(cursor.code).toBe(0);
    expect(JSON.parse(cursor.stdout)).toEqual({
      mcpServers: {
        rooster: { url: `${SERVER}/mcp`, headers: { Authorization: 'Bearer <MCP token>' } },
      },
    });
    expect(cursor.stderr).toContain('Connected apps');
    const desktop = await h.run([
      'mcp',
      'setup',
      '--remote',
      '--client',
      'claude-desktop',
      '--server',
      SERVER,
    ]);
    expect(desktop.code).toBe(0);
    expect(desktop.stderr).toContain(`${SERVER}/mcp`);
    expect(oauth.state.deviceRequests).toEqual([]);
    expect(readdirSync(h.home)).not.toContain('.cursor');
  });
});

describe('rooster token create --audience (11 §9.7)', () => {
  function tokenApi() {
    return fakeApi({
      'POST /api/v1/me/tokens': (call: { body: unknown }) => ({
        token: 'rooster_pat_new',
        grant: {
          id: 'g',
          kind: 'pat',
          clientId: null,
          label: 'x',
          scopes: (call.body as { scopes: string[] }).scopes,
          constraints: { orgs: 'all' },
          tokenPrefix: 'rooster_pat_n',
          createdAt: 0,
          updatedAt: 0,
          expiresAt: null,
          idleTimeoutMs: null,
          client: null,
          lastUsedAt: null,
          lastUsedIp: null,
          current: false,
          audience: (call.body as { audience?: string }).audience ?? 'api',
        },
      }),
    });
  }

  it('sends audience mcp and says where the token works', async () => {
    const api = tokenApi();
    cli = cliHarness({}, { fetch: api.fetch });
    const run = await cli.run(['token', 'create', 'agent', '--audience', 'mcp'], { env: FAKE_ENV });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('rooster_pat_new\n');
    expect(api.calls[0]?.body).toMatchObject({ name: 'agent', audience: 'mcp' });
    expect(run.stderr).toContain(`${FAKE_ENV.ROOSTER_SERVER}/mcp`);
  });

  it('api is the default and isn’t sent (older servers)', async () => {
    const api = tokenApi();
    cli = cliHarness({}, { fetch: api.fetch });
    expect((await cli.run(['token', 'create', 'ci'], { env: FAKE_ENV })).code).toBe(0);
    expect(api.calls[0]?.body).not.toHaveProperty('audience');
    expect(
      (await cli.run(['token', 'create', 'ci', '--audience', 'api'], { env: FAKE_ENV })).code,
    ).toBe(0);
    expect(api.calls[1]?.body).not.toHaveProperty('audience');
  });

  it('refuses admin for an MCP token, an unknown audience and two of them, before any request', async () => {
    const api = tokenApi();
    cli = cliHarness({}, { fetch: api.fetch });
    const admin = await cli.run(
      ['token', 'create', 'x', '--audience', 'mcp', '--scope', 'tasks:read,admin'],
      { env: FAKE_ENV },
    );
    expect(admin.code).toBe(2);
    expect(admin.stderr).toContain('admin');
    for (const argv of [
      ['--audience', 'web'],
      ['--audience', 'api', '--audience', 'mcp'],
      ['--audience', '--json'],
    ]) {
      expect((await cli.run(['token', 'create', 'x', ...argv], { env: FAKE_ENV })).code).toBe(2);
    }
    expect(api.calls).toEqual([]);
  });
});
