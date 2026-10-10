import { describe, expect, it } from 'vitest';
import { readOptions } from '../src/commands/util.ts';
import { CliError } from '../src/errors.ts';
import { FAKE_ENV, fakeApi, ME, ORG } from './support/fake-api.ts';
import { cliHarness } from './support/fake-io.ts';

/**
 * Options are read with real boundaries (security review): a string option's value is never read
 * as another option, and an option never silently loses its value. Above all, a `--scope` or
 * `--org` value that looks like a flag must not widen or narrow a grant.
 */

describe('readOptions', () => {
  const strings = ['scope', 'org', 'desc-file'];

  it('collects repeated values in order, both forms, and switches', () => {
    const given = readOptions(
      ['ci', '--scope', 'tasks:write', '--scope=tasks:read', '--read-only', '--org', 'acme'],
      strings,
    );
    expect(given.values.get('scope')).toEqual(['tasks:write', 'tasks:read']);
    expect(given.values.get('org')).toEqual(['acme']);
    expect([...given.switches]).toEqual(['read-only']);
  });

  it('a value may start with one dash (stdin) or with -- when written with =', () => {
    expect(readOptions(['--desc-file', '-'], strings).values.get('desc-file')).toEqual(['-']);
    expect(readOptions(['--scope=--admin'], strings).values.get('scope')).toEqual(['--admin']);
  });

  it.each([
    [['--scope']],
    [['--scope', '--read-only']],
    [['--org', '--scope', 'admin']],
    [['--scope', '--', 'admin']],
  ])('refuses a missing value: %j', (argv) => {
    try {
      readOptions(argv, strings);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).exitCode).toBe(2);
      expect((error as Error).message).toMatch(/^--(scope|org) needs a value\.$/);
    }
  });

  it('stops at --', () => {
    const given = readOptions(['--org', 'a', '--', '--scope', 'admin'], strings);
    expect(given.values.get('scope')).toBeUndefined();
    expect(given.values.get('org')).toEqual(['a']);
  });
});

async function run(routes: Parameters<typeof fakeApi>[0], argv: string[]) {
  const api = fakeApi({ 'GET /api/v1/me': ME, ...routes });
  const cli = cliHarness({}, { fetch: api.fetch });
  try {
    return { ...(await cli.run(argv, { env: FAKE_ENV })), calls: api.calls };
  } finally {
    cli.cleanup();
  }
}

const tokenRoute = (call: { body: unknown }) => ({
  token: 'rooster_pat_x',
  grant: {
    id: '01a00000-0000-7000-8000-0000000000e1',
    kind: 'pat',
    clientId: null,
    label: 'c',
    scopes: (call.body as { scopes: string[] }).scopes,
    constraints: (call.body as { constraints: unknown }).constraints,
    tokenPrefix: 'rooster_pat_x',
    createdAt: 0,
    updatedAt: 0,
    expiresAt: null,
    lastUsedAt: null,
    lastUsedIp: null,
    current: false,
  },
});

describe('token create: scopes and constraints never come from a misread flag', () => {
  it.each([
    [['--scope', '--read-only']],
    [['--scope', 'tasks:read', '--scope']],
    [['--org', '--scope', 'tasks:write']],
    [['--group', '--write-group', 'acme/Prio']],
    [['--write-group', '--scope', 'admin']],
  ])('%j exits 2 and creates nothing', async (flags) => {
    const result = await run({ 'POST /api/v1/me/tokens': tokenRoute }, [
      'token',
      'create',
      'ci',
      ...flags,
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/needs a value/);
    expect(result.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('repeated and = values are all requested', async () => {
    const result = await run({ 'POST /api/v1/me/tokens': tokenRoute }, [
      'token',
      'create',
      'ci',
      '--scope',
      'tasks:write',
      '--scope=comments:write',
      '--org=acme',
    ]);
    expect(result.code).toBe(0);
    const body = result.calls.find((c) => c.path === '/api/v1/me/tokens')?.body;
    expect(body).toMatchObject({
      scopes: ['tasks:write', 'comments:write'],
      constraints: { orgs: [{ orgId: ORG.id }] },
    });
  });
});

describe('login and ls: missing values are refused before anything is sent', () => {
  it.each([
    [['login', '--scope', '--admin']],
    [['login', '--scope']],
    [['login', '--org', '--with-token']],
    [['login', '--server', '--scope', 'admin']],
  ])('%j exits 2 without a request', async (argv) => {
    const result = await run({}, argv);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/needs a value/);
    expect(result.calls).toEqual([]);
  });

  it('ls --tag --completed exits 2; ls --tag=--completed filters by that tag', async () => {
    const refused = await run({}, ['ls', 'today', '--tag', '--completed']);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('--tag needs a value');
    expect(refused.calls.filter((c) => c.path.includes('/tasks'))).toEqual([]);

    const tagged = await run(
      {
        'GET /api/v1/orgs/*/tasks': { items: [], nextCursor: null },
        'GET /api/v1/orgs/*/tags': [],
      },
      ['ls', 'today', '--tag=--completed', '--tag', '#home'],
    );
    expect(tagged.code).toBe(0);
    const query = tagged.calls.find((c) => /\/orgs\/[^/]+\/tasks$/.test(c.path))?.search ?? '';
    const params = new URLSearchParams(query);
    expect(params.getAll('tag')).toEqual(['--completed', 'home']);
    expect(params.get('completed')).toBe('false');
  });
});
