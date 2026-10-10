import { describe, expect, it } from 'vitest';
import { FAKE_ENV, fakeApi, ME, ORG, problem } from './support/fake-api.ts';
import { cliHarness } from './support/fake-io.ts';

// OSC 52 sets the clipboard; OSC 0 retitles the window; CSI 2J clears the screen.
const OSC52 = '\u001b]52;c;Y3VybCBldmlsLnNoIHwgc2g=\u0007';
const HOSTILE = `Eve${OSC52}\u001b]0;pwned\u0007\u001b[2J\u009b31m`;

function expectClean(text: string) {
  for (const control of ['\u001b', '\u0007', '\u009b']) expect(text).not.toContain(control);
}

async function run(routes: Parameters<typeof fakeApi>[0], argv: string[]) {
  const api = fakeApi({ 'GET /api/v1/me': ME, ...routes });
  const cli = cliHarness({}, { fetch: api.fetch });
  try {
    return { ...(await cli.run(argv, { env: FAKE_ENV })), calls: api.calls };
  } finally {
    cli.cleanup();
  }
}

describe('[P2] untrusted text in errors goes through clean()', () => {
  it('a server problem detail with OSC 52', async () => {
    const result = await run(
      {
        'GET /api/v1/tasks/resolve': problem(422, 'validation_failed', HOSTILE, {
          errors: [{ path: HOSTILE, message: HOSTILE }],
        }),
      },
      ['show', '42'],
    );
    expect(result.code).toBe(5);
    expect(result.stderr).toContain('Eve]52;c;');
    expectClean(result.stderr);
  });

  it('forbidden_scope and outside_grant details', async () => {
    for (const code of ['forbidden_scope', 'outside_grant']) {
      const result = await run({ 'POST /api/v1/orgs/*/tasks': problem(403, code, HOSTILE) }, [
        'add',
        'x',
        '--no-parse',
      ]);
      expect(result.code).toBe(3);
      expectClean(result.stderr);
    }
  });

  it('ambiguous --assign lists member names cleaned', async () => {
    const member = (n: number) => ({
      userId: `01a00000-0000-7000-8000-00000000000${n}`,
      name: `Eve ${n}${OSC52}`,
      email: `eve${n}@example.com`,
      image: null,
      role: 'member',
      joinedAt: 0,
    });
    const result = await run({ 'GET /api/v1/orgs/*/members': [member(1), member(2)] }, [
      'add',
      'x',
      '--assign',
      'eve',
    ]);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('Eve 1');
    expectClean(result.stderr);
    expect(result.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('ambiguous ref candidates', async () => {
    const result = await run(
      {
        'GET /api/v1/tasks/resolve': problem(409, 'ambiguous_ref', 'Several.', {
          candidates: [
            { id: '0192f3a0-0000-7000-8000-000000000001', orgId: ORG.id, seq: 1, title: HOSTILE },
            { id: '0192f3a0-0000-7000-8000-000000000002', orgId: ORG.id, seq: 2, title: 'ok' },
          ],
        }),
      },
      ['show', '0192f3a0'],
    );
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('0192f3a0-0000');
    expectClean(result.stderr);
  });

  it('a user name in whoami and a hostile message in a notice', async () => {
    const result = await run(
      {
        'GET /api/v1/me': { ...ME, name: HOSTILE, email: `a${OSC52}@x.example` },
        'GET /api/v1/me/grants': [],
      },
      ['whoami'],
    );
    expect(result.code).toBe(0);
    expectClean(result.stdout);
  });

  it('P10: an attachment file name in show', async () => {
    const id = '0192f3a0-0000-7000-8000-000000000001';
    const base = {
      id,
      orgId: ORG.id,
      seq: 1,
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
      counts: { subtasks: 0, subtasksDone: 0, comments: 0, attachments: 1 },
      placement: null,
      createdAt: 0,
      updatedAt: 0,
    };
    const result = await run(
      {
        'GET /api/v1/tasks/resolve': base,
        'GET /api/v1/tasks/*': {
          ...base,
          description: '',
          parentChain: [],
          subtasks: [],
          reminders: [],
          attachments: [
            {
              id: '0192f3a0-0000-7000-8000-0000000000a1',
              taskId: id,
              filename: `${HOSTILE}.pdf`,
              mime: 'application/pdf',
              size: 2048,
              uploaderId: ME.id,
              image: null,
              createdAt: 0,
            },
          ],
        },
        'GET /api/v1/orgs/*/tags': [],
      },
      ['show', '1'],
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Attachments\s+Eve.*\.pdf \(2 kB\)/);
    expectClean(result.stdout);
  });
});

describe('[P2] server metadata is validated before it is printed', () => {
  const hostileTask = {
    id: `0192f3a0${OSC52}-0000-7000-8000-000000000001`,
    orgId: ORG.id,
    seq: `42${OSC52}`,
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
    counts: { subtasks: `2${OSC52}`, subtasksDone: 1, comments: 0, attachments: 0 },
    placement: { groupId: '01a00000-0000-7000-8000-00000000000a', position: 'a0' },
    createdAt: 0,
    updatedAt: 0,
  };
  const myList = {
    groups: [
      {
        id: '01a00000-0000-7000-8000-00000000000a',
        orgId: ORG.id,
        kind: 'inbox',
        name: 'Inbox',
        position: 'a0',
        collapsed: false,
      },
    ],
    tasks: [hostileTask],
    expandedTaskIds: [],
    serverTime: 0,
  };

  it('a seq, id and subtask counts in ls and ls --quiet', async () => {
    for (const argv of [['ls'], ['ls', '--quiet']]) {
      const result = await run(
        { 'GET /api/v1/orgs/*/my-list': myList, 'GET /api/v1/orgs/*/tags': [] },
        argv,
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('0192f3a0');
      expect(result.stdout).not.toContain('42');
      expect(result.stdout).not.toMatch(/\d\/2/);
      expectClean(result.stdout);
    }
  });

  it('the device flow user code (login --no-browser) is refused, never printed', async () => {
    const api = fakeApi({
      'GET /api/v1/meta': { version: '1.3.0' },
      'POST /api/auth/device/code': {
        device_code: 'd',
        user_code: `ABCD${OSC52}`,
        verification_uri: 'https://rooster.test/device',
        expires_in: 600,
        interval: 5,
      },
    });
    const cli = cliHarness({}, { fetch: api.fetch });
    try {
      const result = await cli.run(['login', '--no-browser', '--server', 'https://rooster.test']);
      expect(result.code).toBe(3);
      expect(result.stdout).not.toContain('ABCD');
      expectClean(result.stdout);
      expectClean(result.stderr);
      expect(api.calls.some((c) => c.path === '/api/auth/device/token')).toBe(false);
    } finally {
      cli.cleanup();
    }
  });

  it('the server version in --version', async () => {
    const result = await run({ 'GET /api/v1/meta': { version: `1.3.0${OSC52}` } }, ['--version']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^rooster \S+\n$/);
    expectClean(result.stdout);
    expectClean(result.stderr);
  });
});

describe('[P2] an explicit --scope must name at least one capability', () => {
  it('login --scope=, and an empty --scope are usage errors, before any device code', async () => {
    for (const scope of [['--scope=,'], ['--scope', ''], ['--scope', ' , ']]) {
      const api = fakeApi({ 'GET /api/v1/meta': { version: '1.3.0' } });
      const cli = cliHarness({}, { fetch: api.fetch });
      try {
        const result = await cli.run([
          'login',
          '--no-browser',
          '--server',
          'https://rooster.test',
          ...scope,
        ]);
        expect(result.code).toBe(2);
        expect(api.calls.some((c) => c.path === '/api/auth/device/code')).toBe(false);
      } finally {
        cli.cleanup();
      }
    }
  });

  it('token create --scope= is a usage error, before any token is created', async () => {
    const result = await run({}, ['token', 'create', 'ci', '--scope=']);
    expect(result.code).toBe(2);
    expect(result.calls.some((c) => c.method === 'POST')).toBe(false);
  });
});
