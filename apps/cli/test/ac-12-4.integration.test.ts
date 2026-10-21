import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/run.ts';
import { approveDevice, pendingDevice } from './support/device.ts';
import { type CliHarness, cliHarness, type FakeIo, fakeIo } from './support/fake-io.ts';
import { type RoosterServer, startServer, type TestUser } from './support/rooster-server.ts';

/**
 * AC-12.4 against a real server in process: the device grant (11 §9.6), refresh rotation
 * under the per-profile lock, logout through RFC 7009, a 1.7 device session, and the remote
 * MCP setup with `rooster mcp header`.
 */

let server: RoosterServer;
let legacy: RoosterServer;
beforeAll(async () => {
  server = await startServer();
  // The operator switch off: `rooster login` falls back to the legacy device flow, which is
  // how a 1.7 CLI signed in.
  legacy = await startServer({ env: { ROOSTER_OAUTH_DEVICE: 'off' } });
});
afterAll(async () => {
  await server?.close();
  await legacy?.close();
});

/** Real time: the server answers slow_down to polls sooner than its interval. */
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Runs a device login (`argv`) and approves it as `user`, the way the web page does. */
async function approved(
  home: string,
  user: TestUser,
  argv: string[],
): Promise<{ code: number; io: FakeIo }> {
  const io = fakeIo(home, { sleep: realSleep });
  const run = runCli(argv, io);
  let code: string | undefined;
  for (let i = 0; i < 500 && code === undefined; i++) {
    code = /Code: (\S+)/.exec(io.out.join(''))?.[1];
    if (code === undefined) await realSleep(10);
  }
  expect(code).toBeDefined();
  const { requestedScopes } = await pendingDevice(user, code ?? '');
  const ok = await approveDevice(user, code ?? '', {
    scopes: requestedScopes,
    constraints: { orgs: 'all' },
  });
  expect(ok.status).toBe(200);
  return { code: await run, io };
}

function secretFiles(home: string): { path: string; value: Record<string, unknown> }[] {
  const dir = join(home, 'config', 'rooster', 'credentials.d');
  return readdirSync(dir).map((name) => ({
    path: join(dir, name),
    value: JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>,
  }));
}

/** Makes the stored access token look expired, as 15 minutes later. */
function expireAccessToken(home: string): void {
  for (const { path, value } of secretFiles(home)) {
    writeFileSync(path, `${JSON.stringify({ ...value, expiresAt: Date.now() - 1000 })}\n`);
  }
}

type Grant = { id: string; kind: string; current: boolean; audience: string | null };

describe('AC-12.4 the CLI on the device grant', () => {
  let cli: CliHarness;
  afterAll(() => cli?.cleanup());

  it('AC-12.4 login completes through the device grant, survives an expiry with concurrent refreshes, and logout revokes it', async () => {
    const user = await server.user('ac124@example.com', 'Ada');
    cli = cliHarness();
    const login = await approved(cli.home, user, [
      'login',
      '--no-browser',
      '--server',
      server.url,
      '--scope',
      'tasks:write',
    ]);
    expect(login.io.err.join('')).toContain('Signed in as Ada');
    expect(login.code).toBe(0);
    const [stored] = secretFiles(cli.home);
    expect(stored?.value).toMatchObject({ v: 2, kind: 'oauth', audience: 'api' });
    expect(String(stored?.value.token)).toMatch(/^rooster_at_/);
    expect(String(stored?.value.refreshToken)).toMatch(/^rooster_rt_/);
    const firstRefresh = stored?.value.refreshToken;

    const { data: grants } = await user.api<Grant[]>('GET', '/api/v1/me/grants');
    const device = grants.filter((g) => g.kind === 'device');
    expect(device).toHaveLength(1);
    expect(device[0]?.audience).toBe('api');

    // 15 minutes later: two commands at once refresh once between them, so the rotated
    // refresh token is never used twice (which would revoke the grant).
    expireAccessToken(cli.home);
    const [a, b] = await Promise.all([
      cli.run(['add', 'First after expiry']),
      cli.run(['add', 'Second after expiry']),
    ]);
    expect(a.stderr).toBe('');
    expect(b.stderr).toBe('');
    expect([a.code, b.code]).toEqual([0, 0]);
    const [rotated] = secretFiles(cli.home);
    expect(rotated?.value.refreshToken).not.toBe(firstRefresh);
    // The grant is alive: another command works without a new login.
    const ls = await cli.run(['ls']);
    expect(ls.code).toBe(0);
    expect(ls.stdout).toContain('First after expiry');
    expect(ls.stdout).toContain('Second after expiry');

    const out = await cli.run(['logout', '--json']);
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ revoked: true });
    const { data: after } = await user.api<Grant[]>('GET', '/api/v1/me/grants');
    expect(after.filter((g) => g.kind === 'device')).toEqual([]);
    expect(secretFiles(cli.home)).toEqual([]);
  }, 90_000);

  it('AC-12.4 a CLI device session as 1.7 created it still works', async () => {
    const user = await legacy.user('ac124-legacy@example.com', 'Bo');
    const home = cliHarness();
    try {
      // With the device grant off, login takes the legacy flow: a bearer session, stored in
      // the 1.7 format.
      const login = await approved(home.home, user, [
        'login',
        '--no-browser',
        '--server',
        legacy.url,
      ]);
      expect(login.code).toBe(0);
      const [stored] = secretFiles(home.home);
      expect(Object.keys(stored?.value ?? {}).sort()).toEqual(['server', 'token']);
      const add = await home.run(['add', 'Still here']);
      expect(add.code).toBe(0);
      expect((await home.run(['ls'])).stdout).toContain('Still here');
      const out = await home.run(['logout', '--json']);
      expect(JSON.parse(out.stdout)).toMatchObject({ revoked: true });
    } finally {
      home.cleanup();
    }
  }, 60_000);

  it('AC-12.4 mcp setup --remote --client claude-code configures the header helper, and mcp header prints a working /mcp token', async () => {
    const user = await server.user('ac124-mcp@example.com', 'Cy');
    const home = cliHarness();
    try {
      const setup = await approved(home.home, user, [
        'mcp',
        'setup',
        '--remote',
        '--client',
        'claude-code',
        '--no-browser',
        '--server',
        server.url,
      ]);
      expect(setup.io.err.join('')).not.toContain('failed');
      expect(setup.code).toBe(0);
      const printed = setup.io.out.join('');
      const line = printed.split('\n').find((l) => l.startsWith('claude mcp add-json'));
      const entry = JSON.parse(/'(\{.*\})'$/.exec(line ?? '')?.[1] ?? 'null') as {
        type: string;
        url: string;
        headersHelper: string;
      };
      expect(entry.type).toBe('http');
      expect(entry.url).toBe(`${server.url}/mcp`);
      expect(entry.headersHelper).toMatch(/ mcp header --server \S+ --profile agent$/);
      expect(entry.headersHelper).toContain(server.url);
      expect(printed).not.toMatch(/rooster_(at|rt)_/);

      const header = await home.run(['mcp', 'header']);
      expect(header.stderr).toBe('');
      expect(header.code).toBe(0);
      const headers = JSON.parse(header.stdout) as Record<string, string>;
      expect(Object.keys(headers)).toEqual(['Authorization']);
      expect(headers.Authorization).toMatch(/^Bearer rooster_at_/);

      // The token works at /mcp (Streamable HTTP initialize) and not at /api/v1.
      const initialize = await fetch(`${server.url}/mcp`, {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-06-18',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'ac-12.4', version: '1.0.0' },
          },
        }),
      });
      expect(initialize.status).toBe(200);
      const api = await fetch(`${server.url}/api/v1/me`, { headers });
      expect(api.status).toBe(401);

      // After an expiry, the helper refreshes and still answers with a working token.
      expireAccessToken(home.home);
      const again = await home.run(['mcp', 'header']);
      expect(again.code).toBe(0);
      expect(JSON.parse(again.stdout).Authorization).not.toBe(headers.Authorization);
    } finally {
      home.cleanup();
    }
  }, 60_000);
});
