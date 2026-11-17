import { describe, expect, it } from 'vitest';
import { FAKE_ENV, type FakeCall, fakeApi, ME, ORG, problem } from './support/fake-api.ts';
import { cliHarness } from './support/fake-io.ts';

/** The org the tasks move to (ADR 0072). */
const GARDEN = {
  ...ORG,
  id: '01a00000-0000-7000-8000-000000000003',
  slug: 'garden',
  name: 'Riverside Garden Club',
  position: 'a2',
};
const PERSONAL = {
  ...ORG,
  id: '01a00000-0000-7000-8000-000000000002',
  slug: 'ada',
  name: 'Ada',
  isPersonal: true,
  position: 'a1',
};
const group = (id: string, orgId: string, name: string, kind = 'normal', position = 'a1') => ({
  id,
  orgId,
  kind,
  name,
  position,
  collapsed: false,
});
const GARDEN_INBOX = group('01a00000-0000-7000-8000-0000000000e0', GARDEN.id, 'Inbox', 'inbox');
const GARDEN_BEDS = group('01a00000-0000-7000-8000-0000000000e1', GARDEN.id, 'Beds');

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: '01a00000-0000-7000-8000-0000000000c1',
    orgId: ORG.id,
    seq: 42,
    parentId: null,
    subtaskPosition: null,
    title: 'Call the bank',
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
    ...overrides,
  };
}
const SECOND = task({ id: '01a00000-0000-7000-8000-0000000000c2', seq: 43, title: 'Pay rent' });
const PERSONAL_TASK = task({
  id: '01a00000-0000-7000-8000-0000000000c9',
  orgId: PERSONAL.id,
  seq: 3,
});

const PREVIEW = {
  tasks: 1,
  subtasks: 0,
  comments: 0,
  attachments: 0,
  exposes: false,
  newTags: [],
  reassigned: 0,
};

function routes(extra: Record<string, unknown> = {}) {
  return {
    'GET /api/v1/me': { ...ME, orgs: [ORG, PERSONAL, GARDEN] },
    'GET /api/v1/tasks/resolve': (call: FakeCall) => {
      const ref = new URLSearchParams(call.search).get('ref');
      if (ref === '43') return SECOND;
      if (ref === 'ada#3') return PERSONAL_TASK;
      return task();
    },
    'GET /api/v1/tasks/*': (call: FakeCall) => task({ id: call.path.split('/').at(-1) }),
    'GET /api/v1/orgs/*/my-list': (call: FakeCall) => ({
      groups: call.path.includes(GARDEN.id) ? [GARDEN_INBOX, GARDEN_BEDS] : [],
      tasks: [],
      expandedTaskIds: [],
      serverTime: 0,
    }),
    'GET /api/v1/orgs/*/tags': [],
    'GET /api/v1/tasks/move-to-org/preview': PREVIEW,
    'POST /api/v1/tasks/move-to-org': (call: FakeCall) => {
      const ids = (call.body as { ids: string[] }).ids;
      return {
        orgId: GARDEN.id,
        tasks: ids.map((id, i) =>
          task({
            id,
            orgId: GARDEN.id,
            seq: 57 + i,
            placement: { groupId: GARDEN_BEDS.id, position: `a${i}` },
          }),
        ),
        movedIds: ids,
      };
    },
    ...extra,
  };
}

async function run(argv: string[], extra: Record<string, unknown> = {}) {
  const api = fakeApi(routes(extra));
  const cli = cliHarness({}, { fetch: api.fetch });
  try {
    return { ...(await cli.run(argv, { env: FAKE_ENV })), calls: api.calls };
  } finally {
    cli.cleanup();
  }
}

const posts = (calls: FakeCall[]) =>
  calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/tasks/move-to-org');

describe('rooster mv --to-org (ADR 0072 §24)', () => {
  it('moves the tasks in the given order and prints their new refs', async () => {
    const result = await run(['mv', '42', '43', '--to-org', 'garden']);
    expect(result.stderr).toContain('Moved 2 tasks to Riverside Garden Club.');
    expect(result.code).toBe(0);
    expect(posts(result.calls).map((c) => c.body)).toEqual([
      { ids: [task().id, SECOND.id], orgId: GARDEN.id },
    ]);
    const preview = result.calls.find((c) => c.path.endsWith('/move-to-org/preview'));
    expect(new URLSearchParams(preview?.search).get('ids')).toBe(`${task().id},${SECOND.id}`);
    expect(new URLSearchParams(preview?.search).get('orgId')).toBe(GARDEN.id);
    expect(result.stdout).toContain('garden#57');
    expect(result.stdout).toContain('garden#58');
  });

  it('takes an org name or "personal", and --group among my groups in the target org', async () => {
    const result = await run(['mv', '42', '--to-org', 'riverside garden club', '--group', 'beds']);
    expect(result.code).toBe(0);
    expect(posts(result.calls)[0]?.body).toEqual({
      ids: [task().id],
      orgId: GARDEN.id,
      groupId: GARDEN_BEDS.id,
    });
    const personal = await run(['mv', '42', '--to-org', 'personal', '--json']);
    expect(personal.code).toBe(0);
    expect(posts(personal.calls)[0]?.body).toMatchObject({ orgId: PERSONAL.id });
  });

  it('--json prints the move result', async () => {
    const result = await run(['mv', '42', '--to-org', 'garden', '--json']);
    expect(result.code).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json).toMatchObject({ orgId: GARDEN.id, movedIds: [task().id] });
    expect(json.tasks[0].seq).toBe(57);
  });

  it('@last is the moved task', async () => {
    const api = fakeApi(routes());
    const cli = cliHarness({}, { fetch: api.fetch });
    try {
      expect((await cli.run(['mv', '42', '--to-org', 'garden'], { env: FAKE_ENV })).code).toBe(0);
      const shown = await cli.run(['show', '@last', '--json'], { env: FAKE_ENV });
      expect(shown.code).toBe(0);
      expect(api.calls.at(-1)?.path).toBe(`/api/v1/tasks/${task().id}`);
    } finally {
      cli.cleanup();
    }
  });

  it.each([
    [['--bottom'], '--bottom'],
    [['--after', '43'], '--after'],
    [['--before', '43'], '--before'],
  ])('refuses %j with --to-org before sending anything (exit 2)', async (flags, named) => {
    const result = await run(['mv', '42', '--to-org', 'garden', ...flags]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(named);
    expect(result.calls.filter((c) => c.path !== '/api/v1/me')).toEqual([]);
  });

  it('refuses tasks from several orgs (exit 2) and the org they are in (exit 5)', async () => {
    const mixed = await run(['mv', '42', 'ada#3', '--to-org', 'garden']);
    expect(mixed.code).toBe(2);
    expect(mixed.stderr).toContain('different organisations');
    expect(posts(mixed.calls)).toEqual([]);

    const same = await run(['mv', '42', '--to-org', 'acme']);
    expect(same.code).toBe(5);
    expect(same.stderr).toContain('already in Acme');
    expect(same.calls.some((c) => c.path.includes('move-to-org'))).toBe(false);
  });

  it('an unknown org is exit 4', async () => {
    const result = await run(['mv', '42', '--to-org', 'nowhere']);
    expect(result.code).toBe(4);
    expect(posts(result.calls)).toEqual([]);
  });

  it('when others’ comments or files would be shared, needs --yes without a terminal', async () => {
    const exposing = {
      'GET /api/v1/tasks/move-to-org/preview': {
        ...PREVIEW,
        comments: 3,
        attachments: 2,
        exposes: true,
      },
    };
    const refused = await run(['mv', '42', '--to-org', 'garden'], exposing);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain(
      '3 comments and 2 files by other people would become visible to members of Riverside Garden Club; pass --yes',
    );
    expect(posts(refused.calls)).toEqual([]);

    const confirmed = await run(['mv', '42', '--to-org', 'garden', '--yes'], exposing);
    expect(confirmed.code).toBe(0);
    expect(posts(confirmed.calls)).toHaveLength(1);
  });

  it('server text is cleaned, and its refusals map to exit codes', async () => {
    const hostile = await run(['mv', '42', '--to-org', 'garden', '--yes'], {
      'GET /api/v1/me': {
        ...ME,
        orgs: [ORG, { ...GARDEN, name: 'Garden\u001b]52;c;cHduZWQ=\u0007‮' }],
      },
      'GET /api/v1/tasks/move-to-org/preview': { ...PREVIEW, comments: 1, exposes: true },
    });
    expect(hostile.code).toBe(0);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: looking for them is the point.
    expect(hostile.stderr).not.toMatch(/[\u001b\u0007\u202e]/);
    expect(hostile.stderr).toContain('Moved 1 task to Garden]52;c;cHduZWQ=.');

    const outside = await run(['mv', '42', '--to-org', 'garden'], {
      'POST /api/v1/tasks/move-to-org': problem(403, 'outside_grant', 'Outside.'),
    });
    expect(outside.code).toBe(3);
    const gone = await run(['mv', '42', '--to-org', 'garden'], {
      'POST /api/v1/tasks/move-to-org': problem(410, 'conflict_deleted', 'In Trash.'),
    });
    expect(gone.code).toBe(4);
  });
});
