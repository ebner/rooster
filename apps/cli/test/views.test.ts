import { describe, expect, it } from 'vitest';
import { stripAnsi } from '../src/output/color.ts';
import { viewIcon, viewQuery } from '../src/saved-views.ts';
import { FAKE_ENV, fakeApi, ME, ORG } from './support/fake-api.ts';
import { cliHarness } from './support/fake-io.ts';

/** Phase 13 (ADR 0073 B12): `rooster view ls` and `rooster ls --view` over a scripted API. */

const BO = '01a00000-0000-7000-8000-0000000000b0';
const CY = '01a00000-0000-7000-8000-0000000000c0';
const GONE = '01a00000-0000-7000-8000-0000000000d0';
const JUNIPER_TAG = '01a00000-0000-7000-8000-0000000000f1';
const PERSONAL = {
  ...ORG,
  id: '01a00000-0000-7000-8000-000000000002',
  slug: 'ada',
  name: 'Ada',
  isPersonal: true,
  position: 'a1',
};

let seq = 0;
function task(overrides: Record<string, unknown> = {}) {
  seq += 1;
  return {
    id: `01a00000-0000-7000-8000-${String(seq).padStart(12, '0')}`,
    orgId: ORG.id,
    seq,
    parentId: null,
    subtaskPosition: null,
    title: `Task ${seq}`,
    hasDescription: false,
    assigneeId: ME.id,
    createdBy: ME.id,
    dueDate: null,
    dueTime: null,
    dueTz: null,
    startDate: null,
    completedAt: null,
    tagIds: [JUNIPER_TAG],
    counts: { subtasks: 0, subtasksDone: 0, comments: 0, attachments: 0 },
    placement: null,
    createdAt: seq,
    updatedAt: seq,
    ...overrides,
  };
}

function view(overrides: Record<string, unknown> = {}) {
  return {
    id: '01a00000-0000-7000-8000-0000000000a1',
    orgId: ORG.id,
    createdBy: ME.id,
    shared: true,
    name: 'Juniper',
    query: {
      tags: [JUNIPER_TAG],
      tagMode: 'any',
      assignee: 'anyone',
      due: 'any',
      status: 'open',
    },
    archivedAt: null,
    position: 'a1',
    openCount: 4,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const JUNIPER = view();
const SEARCH = view({
  id: '01a00000-0000-7000-8000-0000000000a2',
  name: 'Due this week',
  shared: false,
  position: 'a0',
  openCount: 1,
  query: { tags: [], tagMode: 'any', assignee: 'me', due: 'week', status: 'open' },
});
const ARCHIVED = view({
  id: '01a00000-0000-7000-8000-0000000000a3',
  name: 'Old launch',
  archivedAt: 5,
});

const MEMBERS = [
  { userId: ME.id, name: 'Ada', image: null, role: 'owner', joinedAt: 0 },
  { userId: CY, name: 'Cy', image: null, role: 'member', joinedAt: 0 },
  { userId: BO, name: 'Bo', image: null, role: 'member', joinedAt: 0 },
];

// Rows as the server sends them (unordered): the CLI groups them as the web does.
const PARENT = task({ title: 'Plan the launch', assigneeId: CY, dueDate: '2026-11-20' });
const ROWS = [
  task({ title: 'Unassigned one', assigneeId: null }),
  task({ title: 'Cy later', assigneeId: CY, dueDate: '2026-12-01' }),
  PARENT,
  task({ title: 'Mine, no date', assigneeId: ME.id }),
  task({ title: 'Mine soon', assigneeId: ME.id, dueDate: '2026-11-18' }),
  task({ title: 'Bo’s subtask', assigneeId: BO, parentId: PARENT.id }),
  task({ title: 'Former member’s', assigneeId: GONE }),
];

async function run(argv: string[], routes: Record<string, unknown> = {}) {
  const api = fakeApi({
    'GET /api/v1/me': { ...ME, orgs: [ORG, PERSONAL] },
    'GET /api/v1/orgs/*/views': (call: { search: string }) =>
      call.search.includes('archived=true') ? [ARCHIVED] : [JUNIPER, SEARCH],
    'GET /api/v1/views/*/tasks': { items: ROWS, counts: { open: 7, done: 12 } },
    'GET /api/v1/orgs/*/members': MEMBERS,
    'GET /api/v1/orgs/*/tags': [
      { id: JUNIPER_TAG, orgId: ORG.id, name: 'juniper', color: 'green', createdAt: 0 },
    ],
    ...routes,
  });
  const cli = cliHarness({}, { fetch: api.fetch });
  try {
    return { ...(await cli.run(argv, { env: FAKE_ENV })), calls: api.calls };
  } finally {
    cli.cleanup();
  }
}

describe('rooster view ls (ADR 0073 B9)', () => {
  it('lists the views in my order: icon, name, shared or private, open count', async () => {
    const res = await run(['view', 'ls']);
    expect(res.code, res.stderr).toBe(0);
    expect(stripAnsi(res.stdout).trimEnd().split('\n')).toEqual([
      'Acme · Views',
      '⌕  Due this week  private  1 open',
      '#  Juniper        shared   4 open',
    ]);
  });

  it('--archived, --json and --quiet', async () => {
    const archived = await run(['view', 'ls', '--archived']);
    expect(stripAnsi(archived.stdout)).toContain('Acme · Archived views');
    expect(stripAnsi(archived.stdout)).toContain('Old launch');
    expect(archived.calls.some((c) => c.search.includes('archived=true'))).toBe(true);
    const json = await run(['view', 'ls', '--json']);
    expect(JSON.parse(json.stdout).map((v: { name: string }) => v.name)).toEqual([
      'Due this week',
      'Juniper',
    ]);
    const quiet = await run(['view', 'ls', '--quiet']);
    expect(quiet.stdout.trim().split('\n')).toEqual([SEARCH.id, JUNIPER.id]);
  });

  it('says when there are none, in Swedish too', async () => {
    const res = await run(['view', 'ls'], { 'GET /api/v1/orgs/*/views': [] });
    expect(stripAnsi(res.stdout)).toContain('No views yet');
    const sv = await run(['view', 'ls'], {
      'GET /api/v1/me': { ...ME, locale: 'sv', orgs: [ORG] },
    });
    expect(stripAnsi(sv.stdout)).toContain('Acme · Vyer');
    expect(stripAnsi(sv.stdout)).toContain('⌕  Due this week  privat  1 öppen');
    expect(stripAnsi(sv.stdout)).toContain('#  Juniper        delad   4 öppna');
  });
});

describe('rooster ls --view (ADR 0073 B4, B12)', () => {
  it('groups the rows by person: me, members alphabetically, others, then Unassigned', async () => {
    const res = await run(['ls', '--view', 'juniper']);
    expect(res.code, res.stderr).toBe(0);
    const lines = stripAnsi(res.stdout).trimEnd().split('\n');
    expect(lines[0]).toBe('Acme · Juniper  7 open · 12 done');
    expect(lines.filter((l) => /^\S.* \(\d+\)$/.test(l))).toEqual([
      'Ada (you) (2)',
      'Bo (1)',
      'Cy (2)',
      'Former member (1)',
      'Unassigned (1)',
    ]);
    // A subtask is a row of its own, with a breadcrumb to its parent (B5).
    expect(lines.find((l) => l.includes('Bo’s subtask'))).toContain('Plan the launch');
    // Never a colleague's email.
    expect(res.stdout).not.toContain('@example.com');
  });

  it('--json is a flat array in display order; --quiet the refs', async () => {
    const res = await run(['ls', '--view', 'Juniper', '--json']);
    const titles = JSON.parse(res.stdout).map((t: { title: string }) => t.title);
    expect(titles).toEqual([
      'Mine soon',
      'Mine, no date',
      'Bo’s subtask',
      'Plan the launch',
      'Cy later',
      'Former member’s',
      'Unassigned one',
    ]);
    const quiet = await run(['ls', '--view', 'Juniper', '--quiet']);
    expect(quiet.stdout.trim().split('\n')).toHaveLength(7);
  });

  it('resolves by ID (archived too), by name in any case, and #name; --completed asks for them', async () => {
    const byId = await run(['ls', '--view', SEARCH.id, '--completed', '--json']);
    expect(byId.code, byId.stderr).toBe(0);
    const call = byId.calls.find((c) => c.path.endsWith('/tasks'));
    expect(call?.path).toBe(`/api/v1/views/${SEARCH.id}/tasks`);
    expect(call?.search).toContain('completed=true');
    // The view's own filter (me) leaves one section.
    expect(JSON.parse(byId.stdout).map((t: { title: string }) => t.title)).toEqual(['Mine soon']);
    const hash = await run(['ls', '--view', '#JUNIPER', '--quiet']);
    expect(hash.code, hash.stderr).toBe(0);
    expect(hash.calls.find((c) => c.path.endsWith('/tasks'))?.search).toBe('');
    const old = await run(['ls', '--view', ARCHIVED.id, '--quiet']);
    expect(old.code, old.stderr).toBe(0);
    expect(old.calls.some((c) => c.path === `/api/v1/views/${ARCHIVED.id}/tasks`)).toBe(true);
  });

  it('an unknown name lists the views; two of the same name ask for an ID (exit 4)', async () => {
    const unknown = await run(['ls', '--view', 'Nope']);
    expect(unknown.code).toBe(4);
    expect(unknown.stderr).toContain(
      'No view called “Nope” in Acme. Its views: Due this week, Juniper',
    );
    const twice = await run(['ls', '--view', 'juniper'], {
      'GET /api/v1/orgs/*/views': [
        JUNIPER,
        view({ id: '01a00000-0000-7000-8000-0000000000a9', shared: false }),
      ],
    });
    expect(twice.code).toBe(4);
    expect(twice.stderr).toContain(`${JUNIPER.id} (shared)`);
    expect(twice.stderr).toContain('01a00000-0000-7000-8000-0000000000a9 (private)');
    expect(twice.calls.some((c) => c.path.endsWith('/tasks'))).toBe(false);
  });

  it('refuses list flags and a list name with --view (exit 2)', async () => {
    for (const argv of [
      ['ls', 'today', '--view', 'Juniper'],
      ['ls', '--view', 'Juniper', '--group', 'Inbox'],
      ['ls', '--view', 'Juniper', '--tag', 'x'],
      ['ls', '--view', 'Juniper', '--all-orgs'],
      ['ls', '--view', 'Juniper', '--upcoming'],
      ['ls', '--view='],
      ['ls', '--view'],
    ]) {
      const res = await run(argv);
      expect(res.code, argv.join(' ')).toBe(2);
      expect(
        res.calls.some((c) => c.path.includes('/views')),
        argv.join(' '),
      ).toBe(false);
    }
    expect((await run(['today', '--view', 'Juniper'])).code).toBe(2);
  });

  it('a personal org has one section and no person headers', async () => {
    const res = await run(['ls', '--view', 'Juniper', '--org', 'personal'], {
      'GET /api/v1/views/*/tasks': {
        items: [task({ orgId: PERSONAL.id, title: 'Only mine', dueDate: '2026-11-18' })],
        counts: { open: 1, done: 0 },
      },
    });
    expect(res.code, res.stderr).toBe(0);
    const lines = stripAnsi(res.stdout).trimEnd().split('\n');
    expect(lines[0]).toBe('Ada · Juniper  1 open · 0 done');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('Only mine');
    expect(res.calls.some((c) => c.path.endsWith('/members'))).toBe(false);
  });

  it('cleans hostile view and member names', async () => {
    const hostile = 'Eve\u001b]52;c;eA==\u0007\u001b[2J';
    const res = await run(['ls', '--view', 'x'], {
      'GET /api/v1/orgs/*/views': [view({ name: hostile })],
    });
    expect(res.code).toBe(4);
    expect(res.stderr).not.toContain('\u001b');
    const listed = await run(['view', 'ls'], {
      'GET /api/v1/orgs/*/views': [view({ name: hostile })],
    });
    expect(listed.stdout).not.toContain('\u0007');
    const rows = await run(['ls', '--view', JUNIPER.id], {
      'GET /api/v1/orgs/*/members': [{ ...MEMBERS[1], name: hostile }],
      'GET /api/v1/orgs/*/views': [view()],
    });
    expect(rows.code, rows.stderr).toBe(0);
    expect(stripAnsi(rows.stdout)).not.toContain('\u0007');
    expect(stripAnsi(rows.stdout)).toContain('Eve]52;c;eA==');
  });
});

describe('the order of people follows the user’s language (AC-13.5)', () => {
  it('a Swedish user with an English CLI gets the web’s (Swedish) order', async () => {
    const ASA = '01a00000-0000-7000-8000-0000000000e1';
    const ZED = '01a00000-0000-7000-8000-0000000000e2';
    const api = fakeApi({
      'GET /api/v1/me': { ...ME, locale: 'sv', orgs: [ORG] },
      'GET /api/v1/orgs/*/views': [JUNIPER],
      'GET /api/v1/views/*/tasks': {
        items: [
          task({ title: 'Zed’s', assigneeId: ZED }),
          task({ title: 'Åsa’s', assigneeId: ASA }),
        ],
        counts: { open: 2, done: 0 },
      },
      'GET /api/v1/orgs/*/members': [
        MEMBERS[0],
        { userId: ASA, name: 'Åsa', image: null, role: 'member', joinedAt: 0 },
        { userId: ZED, name: 'Zed', image: null, role: 'member', joinedAt: 0 },
      ],
      'GET /api/v1/orgs/*/tags': [],
    });
    const cli = cliHarness({}, { fetch: api.fetch });
    try {
      const env = { ...FAKE_ENV, ROOSTER_PROFILE: 'default' };
      expect((await cli.run(['config', 'set', 'locale', 'en'], { env })).code).toBe(0);
      const res = await cli.run(['ls', '--view', 'Juniper', '--json'], { env });
      expect(res.code, res.stderr).toBe(0);
      expect(JSON.parse(res.stdout).map((t: { title: string }) => t.title)).toEqual([
        'Zed’s',
        'Åsa’s',
      ]);
      // The CLI itself still speaks English.
      const text = await cli.run(['ls', '--view', 'Juniper'], { env });
      expect(stripAnsi(text.stdout)).toContain('2 open · 0 done');
    } finally {
      cli.cleanup();
    }
  });
});

describe('a view’s query from the API (type-cast, so checked)', () => {
  it('reads a valid query; anything else lists every row the server sent', () => {
    expect(viewQuery(JUNIPER as never)).toEqual(JUNIPER.query);
    expect(viewIcon(JUNIPER as never)).toBe('#');
    expect(viewIcon(SEARCH as never)).toBe('⌕');
    const broken = { query: { tags: 'nope', status: 42 } as never };
    expect(viewQuery(broken)).toEqual({
      tags: [],
      tagMode: 'any',
      assignee: 'anyone',
      due: 'any',
      status: 'any',
    });
    expect(viewIcon(broken)).toBe('⌕');
  });
});
