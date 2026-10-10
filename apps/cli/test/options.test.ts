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

describe('review verification: the whole command line is checked before globals are lifted', () => {
  const editRoutes = () => {
    const dto = {
      id: '0192f3a0-0000-7000-8000-000000000001',
      orgId: ORG.id,
      seq: 41,
      parentId: null,
      subtaskPosition: null,
      title: 'Report',
      hasDescription: false,
      assigneeId: ME.id,
      createdBy: ME.id,
      dueDate: null,
      dueTime: null,
      dueTz: null,
      startDate: null,
      completedAt: null,
      tagIds: [],
      counts: { subtasks: 0, subtasksDone: 0, comments: 0, attachments: 0 },
      placement: null,
      createdAt: 0,
      updatedAt: 0,
    };
    return {
      'GET /api/v1/tasks/resolve': dto,
      'GET /api/v1/tasks/*': { ...dto, description: '', parentChain: [], subtasks: [] },
      'PATCH /api/v1/tasks/*': (call: { body: unknown }) => ({
        task: { ...dto, ...(call.body as object) },
        ignoredFields: [],
      }),
      'GET /api/v1/orgs/*/tags': [],
      'POST /api/v1/me/tokens': tokenRoute,
    };
  };
  const writes = <T extends { method: string }>(calls: T[]) =>
    calls.filter((c) => c.method !== 'GET');

  it.each([
    // citty would read these camelCase spellings past any check of the declared names.
    [['edit', '41', '--descFile', '--no-remind', '-'], '--descFile'],
    [
      ['token', 'create', 'agent', '--scope', 'tasks:write', '--writeGroup', 'acme/Prio'],
      '--writeGroup',
    ],
    [['edit', '41', '--no-title'], '--no-title'],
    [['add', 'x', '-z'], '-z'],
    [['ls', '--allOrgs'], '--allOrgs'],
  ])('%j: unknown spelling %s exits 2 and sends nothing', async (argv, flag) => {
    const result = await run(editRoutes(), argv);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(`Unknown option ${flag}`);
    expect(writes(result.calls)).toEqual([]);
  });

  it.each([
    [['token', 'create', 'agent', '--scope', '--quiet', 'tasks:write'], '--scope'],
    [['token', 'create', 'agent', '--scope', '-q', 'tasks:write'], '--scope'],
    [['edit', '41', '--title', '--org=acme', 'changed'], '--title'],
    [['edit', '41', '--title', '--json', 'changed'], '--title'],
    [['edit', '41', '--title', '-y', 'changed'], '--title'],
    [['--profile', '--json', 'ls'], '--profile'],
  ])('%j: a global flag is never lifted out of %s', async (argv, flag) => {
    const result = await run(editRoutes(), argv);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(`${flag} needs a value`);
    expect(writes(result.calls)).toEqual([]);
  });

  it('a boolean takes no value', async () => {
    const result = await run(editRoutes(), ['add', 'x', '--bottom=false']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--bottom takes no value');
  });

  it('declared spellings, globals anywhere, = values and the tag form still work', async () => {
    const ok = await run(editRoutes(), ['--json', 'edit', '41', '--title=--org=acme', '-q']);
    expect(ok.code).toBe(0);
    expect(writes(ok.calls).map((c) => c.body)).toEqual([{ title: '--org=acme' }]);
    const token = await run(editRoutes(), [
      'token',
      'create',
      'agent',
      '--scope',
      'tasks:write',
      '--write-group',
      'acme/Inbox',
      '--json',
    ]);
    expect(token.stderr).not.toContain('Unknown option');
    expect(token.stderr).not.toContain('needs a value');
  });
});

describe('checkArgv', () => {
  it('accepts the tag form, negations of booleans and edit --no-remind', async () => {
    const { checkCommandLine } = await import('../src/cli.ts');
    for (const argv of [
      ['tag', '42', '-urgent', '+home'],
      ['tag', 'add', 'home', '--color', 'blue'],
      ['add', 'x', '--no-parse', '--remind', '1h', '--', '-literal'],
      ['edit', '41', '--no-remind'],
      ['login', '--org', 'acme', '--no-browser'],
      ['ls', '--org', 'acme', '--tag', 'x'],
      ['__complete', 'groups', '--profile', 'work'],
      ['add', 'x', '--desc-file', '-'],
      ['--version'],
      ['add', '--help'],
    ]) {
      await expect(checkCommandLine(argv)).resolves.toBeUndefined();
    }
    for (const argv of [
      ['add', 'x', '--no-remind'],
      ['tag', '-urgent'],
      ['ls', '--tag', '-x'],
    ]) {
      await expect(checkCommandLine(argv)).rejects.toBeInstanceOf(CliError);
    }
  });
});

describe('review final check: refusals keep --json, and nothing goes before a subcommand', () => {
  it('a refused command line still reports in JSON when --json was given as a flag', async () => {
    const result = await run({}, ['--json', 'edit', '41', '--title']);
    expect(result.code).toBe(2);
    const error = JSON.parse(result.stderr.trim()) as {
      error: { exitCode: number; message: string };
    };
    expect(error.error.exitCode).toBe(2);
    expect(error.error.message).toContain('--title needs a value');
    // After the command, too.
    const after = await run({}, ['edit', '41', '--descFile', 'x', '--json']);
    expect(JSON.parse(after.stderr.trim()).error.message).toContain('Unknown option --descFile');
    // A refused value position is not consumed, so `--json` there is still the flag; a value
    // given with = is never read as one.
    const plain = await run({}, ['edit', '41', '--title=--json', '--bogus']);
    expect(plain.code).toBe(2);
    expect(plain.stderr).toContain('Unknown option --bogus');
    expect(() => JSON.parse(plain.stderr.trim())).toThrow();
  });

  it.each([
    [['token', '--org=acme', 'create', 'agent', '--scope', 'tasks:write'], 'Put --org after'],
    [['--org', 'acme', 'token', 'create', 'agent'], 'Put --org after'],
    [['--org', 'acme', 'login'], 'Put --org after'],
    [['token', '--scope', 'tasks:write', 'create', 'agent'], 'Unknown option --scope'],
    // `mcp` declares --read-only for serving; before `setup` it would be dropped.
    [['mcp', '--read-only', 'setup'], 'Put --read-only after'],
  ])('%j is refused: %s', async (argv, message) => {
    const result = await run({ 'POST /api/v1/me/tokens': tokenRoute }, argv);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(message);
    expect(result.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('globals before a subcommand still work, and --org stays global for other commands', async () => {
    const { checkCommandLine } = await import('../src/cli.ts');
    for (const argv of [
      ['--org', 'acme', 'tag', 'add', 'home'],
      ['--json', '--profile', 'work', 'token', 'create', 'agent', '--org', 'acme'],
      ['--org', 'acme', 'group', 'add', 'Prio'],
      ['login', '--org', 'acme'],
      ['-q', 'mcp', 'setup', '--no-browser'],
    ]) {
      await expect(checkCommandLine(argv)).resolves.toBeUndefined();
    }
  });
});
