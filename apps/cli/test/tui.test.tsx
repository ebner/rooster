import { writeFileSync } from 'node:fs';
import { addDays, todayIn } from '@rooster/core/dates';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type CliHarness, cliHarness } from './support/fake-io.ts';
import { type RoosterServer, startServer, type TestUser } from './support/rooster-server.ts';
import { KEY, openTui, type TuiHarness } from './support/tui.ts';

interface TaskJson {
  id: string;
  title: string;
  parentId: string | null;
  dueDate: string | null;
  completedAt: number | null;
  tagIds: string[];
  description?: string;
  placement: { groupId: string; position: string } | null;
}
interface GroupJson {
  id: string;
  name: string;
  kind: string;
  position: string;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: looking for them is the point.
const UNSAFE_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

let server: RoosterServer;
let open: TuiHarness[] = [];
let seq = 0;

beforeAll(async () => {
  server = await startServer();
});
afterEach(() => {
  for (const tui of open) tui.close();
  open = [];
});
afterAll(async () => {
  await server?.close();
});

const SCOPES = ['tasks:read', 'tasks:write', 'tasks:delete', 'groups:write', 'comments:write'];

/** A fresh user signed in from a fresh CLI home. */
async function setup(name = 'Ada'): Promise<{ user: TestUser; cli: CliHarness }> {
  seq += 1;
  const user = await server.user(`tui${seq}@example.com`, name);
  const { token } = await user.token({ scopes: SCOPES as never });
  const cli = cliHarness();
  const login = await cli.run(['login', '--with-token', '--server', server.url], { stdin: token });
  expect(login.code).toBe(0);
  return { user, cli };
}

async function tui(
  cli: CliHarness,
  options: Parameters<typeof openTui>[1] = {},
): Promise<TuiHarness> {
  const harness = await openTui(cli, options);
  open.push(harness);
  return harness;
}

async function myList(user: TestUser) {
  const { data } = await user.api<{ groups: GroupJson[]; tasks: TaskJson[] }>(
    'GET',
    '/api/v1/orgs/personal/my-list',
  );
  return data;
}

/** Titles of the tasks placed in a group, in list order. */
async function titlesIn(user: TestUser, groupName: string): Promise<string[]> {
  const list = await myList(user);
  const group = list.groups.find((g) => g.name === groupName);
  return list.tasks
    .filter((t) => t.placement?.groupId === group?.id)
    .sort((a, b) =>
      (a.placement?.position ?? '') < (b.placement?.position ?? '')
        ? -1
        : (a.placement?.position ?? '') > (b.placement?.position ?? '')
          ? 1
          : 0,
    )
    .map((t) => t.title);
}

async function addTask(user: TestUser, body: Record<string, unknown>): Promise<TaskJson> {
  const { status, data } = await user.api<TaskJson>('POST', '/api/v1/orgs/personal/tasks', body);
  expect(status).toBe(201);
  return data;
}

/** Tasks shown in the Inbox in this order (the server adds new tasks at the top). */
async function addTasks(user: TestUser, ...titles: string[]): Promise<TaskJson[]> {
  const out: TaskJson[] = [];
  for (const title of [...titles].reverse()) out.unshift(await addTask(user, { title }));
  return out;
}

async function today(user: TestUser): Promise<string> {
  const { data } = await user.api<{ timezone: string }>('GET', '/api/v1/me');
  return todayIn(data.timezone, Date.now());
}

/** The row of the selected task (the line with `›`). */
const selectedRow = (frame: string) => frame.split('\n').find((line) => line.includes('│ › '));

async function eventually<T>(fn: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (check(value)) return value;
    if (Date.now() - started > 3_000) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('TUI: layout', () => {
  it('shows the org, sync status, view tabs, groups, rows and key hints (07 §5)', async () => {
    const { user, cli } = await setup();
    const day = await today(user);
    await addTask(user, { title: 'Book dentist', dueDate: addDays(day, 1) });
    await addTask(user, { title: 'Reply to Anna #mail', parse: true, dueDate: day });
    const t = await tui(cli);
    const frame = await t.waitFor((f) => f.includes('Book dentist') && f.includes('synced'));
    const lines = frame.split('\n');
    expect(lines[0]).toMatch(/^┌ rooster ─ Personal ▾ ─+ ● synced ┐$/);
    expect(lines[1]).toMatch(/│ My tasks │ Today 1 │ 7 days │ Overdue │ No date\s+│/);
    expect(frame).toContain('▾ Inbox (2)');
    expect(frame).toMatch(/› ○ Reply to Anna\s+#mail {2}Today/);
    expect(frame).toMatch(/○ Book dentist\s+Tomorrow/);
    expect(lines.at(-2)).toMatch(/j\/k move .* \? help/);
    // Every line is exactly the terminal width.
    for (const line of lines) expect([...line].length).toBe(100);
    expect(lines).toHaveLength(30);
  });

  it('resize: narrow terminals keep the frame, the current tab and the title', async () => {
    const { user, cli } = await setup();
    await addTask(user, {
      title: 'A rather long task title that will not fit',
      dueDate: await today(user),
    });
    const t = await tui(cli);
    await t.waitFor((f) => f.includes('A rather long'));
    t.resize(44, 12);
    let frame = await t.waitFor((f) => f.split('\n')[0]?.length === 44);
    expect(frame.split('\n')).toHaveLength(12);
    for (const line of frame.split('\n')) expect([...line].length).toBe(44);
    expect(frame.split('\n')[0]).toMatch(/^┌ rooster ─ .*┐$/);
    expect(frame).toContain('My tasks');
    expect(frame).toContain('A rather long');
    await t.press('g', 'n');
    frame = await t.waitFor((f) => f.includes('No date') && !f.includes('A rather long'));
    expect(frame.split('\n')[1]).toContain('No date');
    t.resize(30, 8);
    frame = await t.waitFor((f) => f.split('\n')[0]?.length === 30);
    for (const line of frame.split('\n')) expect([...line].length).toBe(30);
    expect(frame.split('\n')[0]).toMatch(/^┌ rooster ─ .*┐$/);
    expect(frame.split('\n').at(-1)).toMatch(/^└─+┘$/);
    t.resize(20, 5);
    frame = await t.waitFor((f) => f.includes('Make the'));
    expect(frame.split('\n')[0]).toContain('Make the');
    t.resize(100, 30);
    await t.waitFor((f) => f.includes('rooster ─ Personal'));
  });
});

describe('TUI: navigation, views and orgs', () => {
  it('j/k and arrows move the selection; g then a key switches views; 1–9 switch orgs', async () => {
    const { user, cli } = await setup();
    const day = await today(user);
    await addTask(user, { title: 'Third', dueDate: addDays(day, -2) });
    await addTask(user, { title: 'Second', dueDate: day });
    await addTask(user, { title: 'First' });
    const { status } = await user.api('POST', '/api/v1/orgs', {
      name: 'Acme',
      slug: `acme-${seq}`,
    });
    expect(status).toBe(201);
    const t = await tui(cli);
    await t.waitFor((f) => f.includes('Third'));
    expect(selectedRow(t.frame())).toContain('First');
    await t.press('j');
    await t.waitFor((f) => selectedRow(f)?.includes('Second') === true);
    await t.press(KEY.down);
    await t.waitFor((f) => selectedRow(f)?.includes('Third') === true);
    await t.press('k', KEY.up);
    await t.waitFor((f) => selectedRow(f)?.includes('First') === true);
    // Overdue badge, then the Today view: the overdue section first, then today's.
    expect(t.frame().split('\n')[1]).toMatch(/Today 2 │ 7 days │ Overdue 1/);
    await t.press('g', 't');
    let frame = await t.waitFor((f) => f.includes('Overdue (1)'));
    expect(frame.indexOf('Third')).toBeLessThan(frame.indexOf('Second'));
    expect(frame).not.toContain('First');
    await t.press('g', 'o');
    frame = await t.waitFor((f) => !f.includes('Second') && f.includes('Third'));
    await t.press('g', 'n');
    frame = await t.waitFor((f) => f.includes('First') && !f.includes('Third'));
    await t.press('g', 'w');
    frame = await t.waitFor((f) => f.includes('Second') && f.includes('Tomorrow'));
    await t.press('g', 'm');
    await t.waitFor((f) => f.includes('Inbox (3)'));
    // Everyone's tasks only exists in shared orgs.
    await t.press('g', 'e');
    await t.waitFor((f) => f.includes('only in shared organisations'));
    // Org 2 (Acme, shared): its own empty list, then Everyone's tasks.
    await t.press('2');
    frame = await t.waitFor((f) => f.includes('rooster ─ Acme') && f.includes('No tasks yet'));
    expect(frame.split('\n')[1]).toContain('Everyone’s tasks');
    await addTask(user, { title: 'Acme task' }).catch(() => undefined);
    await user.api('POST', `/api/v1/orgs/acme-${seq}/tasks`, { title: 'Shared plan' });
    await t.press('g', 'e');
    frame = await t.waitFor((f) => f.includes('Ada (you)') && f.includes('Shared plan'));
    expect(frame).toContain('Unassigned (0)');
    await t.press('1');
    await t.waitFor((f) => f.includes('rooster ─ Personal') && f.includes('First'));
  });

  it('? shows the help generated from the keymap, with the differences from the web', async () => {
    const { cli } = await setup();
    const t = await tui(cli, { rows: 60 });
    await t.waitFor((f) => f.includes('synced'));
    await t.press('?');
    const frame = await t.waitFor((f) => f.includes('Keyboard shortcuts'));
    expect(frame).toMatch(/x\s+Complete or reopen/);
    expect(frame).toMatch(/g e\s+Go to Everyone’s tasks/);
    expect(frame).toContain('Differences from the web');
    expect(frame).toMatch(/x\s+On the web: Ctrl\+Enter/);
    expect(frame).toMatch(/J\s+On the web: Ctrl\+↓/);
    expect(frame).toMatch(/q Ctrl\+C\s+On the web, q is quick add/);
    await t.press(KEY.esc);
    await t.waitFor((f) => !f.includes('Keyboard shortcuts'));
  });
});

describe('TUI: editing', () => {
  it('n creates below with NL parsing, Enter chains the next draft; N creates above', async () => {
    const { user, cli } = await setup();
    const day = await today(user);
    await addTasks(user, 'Alpha', 'Omega');
    const t = await tui(cli);
    await t.waitFor((f) => f.includes('Omega'));
    await t.press('n');
    await t.waitFor((f) => f.includes('› ○ ▏'));
    await t.type('Pay invoice tom #finance');
    await t.press(KEY.enter);
    // The task exists, parsed by the server; a new draft opened below it.
    await t.waitFor((f) => /○ Pay invoice\s+#finance {2}Tomorrow/.test(f) && f.includes('› ○ ▏'));
    await t.type('Call bank');
    await t.press(KEY.esc);
    await t.waitFor((f) => f.includes('Call bank') && !f.includes('▏'));
    expect(await titlesIn(user, 'Inbox')).toEqual(['Alpha', 'Pay invoice', 'Call bank', 'Omega']);
    const parsed = (await myList(user)).tasks.find((task) => task.title === 'Pay invoice');
    expect(parsed?.dueDate).toBe(addDays(day, 1));
    // N: above the selected row (Call bank).
    await t.press('N');
    await t.type('Before call');
    await t.press(KEY.esc);
    await t.waitFor((f) => f.includes('Before call') && !f.includes('▏'));
    expect(await titlesIn(user, 'Inbox')).toEqual([
      'Alpha',
      'Pay invoice',
      'Before call',
      'Call bank',
      'Omega',
    ]);
  });

  it('Enter edits the title; u undoes it and Ctrl+R redoes it', async () => {
    const { user, cli } = await setup();
    const task = await addTask(user, { title: 'Old title' });
    const t = await tui(cli);
    await t.waitFor((f) => f.includes('Old title'));
    await t.press(KEY.enter);
    await t.waitFor((f) => f.includes('Old title▏'));
    for (let i = 0; i < 'title'.length; i++) await t.press(KEY.backspace);
    await t.type('name');
    await t.press(KEY.enter);
    await t.waitFor((f) => f.includes('Old name') && !f.includes('▏'));
    const title = async () =>
      (await user.api<TaskJson>('GET', `/api/v1/tasks/${task.id}`)).data.title;
    expect(await eventually(title, (v) => v === 'Old name')).toBe('Old name');
    await t.press('u');
    await t.waitFor((f) => f.includes('Old title') && f.includes('Undone'));
    expect(await title()).toBe('Old title');
    await t.press(KEY.ctrlR);
    await t.waitFor((f) => f.includes('Old name') && f.includes('Redone'));
    expect(await title()).toBe('Old name');
  });

  it('x completes (with the undo hint) and u reopens', async () => {
    const { user, cli } = await setup();
    const task = await addTask(user, { title: 'Book dentist' });
    const t = await tui(cli);
    await t.waitFor((f) => f.includes('Book dentist'));
    await t.press('x');
    // The tick is optimistic; the undo hint can arrive a frame later.
    await t.waitFor(
      (f) => f.includes('✓ Book dentist') && /Completed “Book dentist” {2}u undo/.test(f),
    );
    const completedAt = async () =>
      (await user.api<TaskJson>('GET', `/api/v1/tasks/${task.id}`)).data.completedAt;
    expect(await eventually(completedAt, (v) => v !== null)).not.toBeNull();
    await t.press('u');
    await t.waitFor((f) => f.includes('○ Book dentist') && f.includes('Undone'));
    expect(await eventually(completedAt, (v) => v === null)).toBeNull();
  });

  it('d sets a date from a phrase or a suggestion, and clears it with none', async () => {
    const { user, cli } = await setup();
    const day = await today(user);
    const task = await addTask(user, { title: 'Water plants' });
    const t = await tui(cli);
    await t.waitFor((f) => f.includes('Water plants'));
    await t.press('d');
    await t.waitFor((f) => f.includes('Date ▏') && f.includes('next week'));
    await t.type('tomorrow');
    await t.waitFor((f) => f.includes('→ Tomorrow'));
    await t.press(KEY.enter);
    await t.waitFor((f) => /Water plants\s+Tomorrow/.test(f));
    const due = async () =>
      (await user.api<TaskJson>('GET', `/api/v1/tasks/${task.id}`)).data.dueDate;
    expect(await eventually(due, (v) => v === addDays(day, 1))).toBe(addDays(day, 1));
    // A phrase that is not a date keeps the picker open with the reason.
    await t.press('d');
    await t.type('someday');
    await t.press(KEY.enter);
    await t.waitFor((f) => f.includes('someday'));
    await t.press(KEY.esc);
    // The last suggestion is "none".
    await t.press('d', KEY.up, KEY.enter);
    await t.waitFor((f) => !/Water plants\s+Tomorrow/.test(f) && !f.includes('Date ▏'));
    expect(await eventually(due, (v) => v === null)).toBeNull();
  });

  it('t toggles tags and creates new ones; s adds a subtask under an expanded parent', async () => {
    const { user, cli } = await setup();
    const task = await addTask(user, { title: 'Plan trip' });
    const t = await tui(cli);
    await t.waitFor((f) => f.includes('Plan trip'));
    await t.press('t');
    await t.type('travel');
    await t.waitFor((f) => f.includes('Create #travel'));
    await t.press(KEY.enter);
    await t.waitFor((f) => /Plan trip\s+#travel/.test(f));
    await t.press(KEY.esc);
    const tags = async () =>
      (await user.api<TaskJson>('GET', `/api/v1/tasks/${task.id}`)).data.tagIds;
    expect(await eventually(tags, (v) => v.length === 1)).toHaveLength(1);
    // Toggle it off again from the list.
    await t.press('t');
    await t.waitFor((f) => f.includes('✓ #travel'));
    await t.press(KEY.enter, KEY.esc);
    expect(await eventually(tags, (v) => v.length === 0)).toHaveLength(0);
    await t.press('s');
    await t.type('Book flights');
    await t.press(KEY.esc);
    const frame = await t.waitFor(
      (f) => /Plan trip\s+▾ 0\/1/.test(f) && / {2}○ Book flights/.test(f),
    );
    expect(frame).toBeTruthy();
    const list = await myList(user);
    expect(list.tasks.find((x) => x.title === 'Book flights')?.parentId).toBe(task.id);
  });

  it('m moves to a group by digit; J/K and ]/[ move with intents the server resolves', async () => {
    const { user, cli } = await setup();
    await addTasks(user, 'One', 'Two', 'Three');
    const t = await tui(cli);
    await t.waitFor((f) => f.includes('Three'));
    await t.press('J');
    expect(
      await eventually(
        () => titlesIn(user, 'Inbox'),
        (v) => v[0] === 'Two',
      ),
    ).toEqual(['Two', 'One', 'Three']);
    await t.waitFor((f) => f.indexOf('Two') < f.indexOf('One'));
    await t.press('K');
    expect(
      await eventually(
        () => titlesIn(user, 'Inbox'),
        (v) => v[0] === 'One',
      ),
    ).toEqual(['One', 'Two', 'Three']);
    // ] goes to the start of the next group (Today), [ back to the end of the Inbox.
    await t.press(']');
    expect(
      await eventually(
        () => titlesIn(user, 'Today'),
        (v) => v.length === 1,
      ),
    ).toEqual(['One']);
    await t.waitFor((f) => f.includes('Today (1)'));
    await t.press('[');
    expect(
      await eventually(
        () => titlesIn(user, 'Inbox'),
        (v) => v.length === 3,
      ),
    ).toEqual(['Two', 'Three', 'One']);
    // m, then 3: the third group in the picker (Inbox, Today, Prio, …).
    await t.waitFor((f) => selectedRow(f)?.includes('One') === true);
    await t.press('m');
    await t.waitFor((f) => f.includes('Move to ▏') && f.includes('3   Prio'));
    await t.press('3');
    expect(
      await eventually(
        () => titlesIn(user, 'Prio'),
        (v) => v.length === 1,
      ),
    ).toEqual(['One']);
    await t.waitFor((f) => f.includes('Moved to Prio'));
    await t.press('u');
    expect(
      await eventually(
        () => titlesIn(user, 'Inbox'),
        (v) => v.length === 3,
      ),
    ).toEqual(['Two', 'Three', 'One']);
    // Smart views are sorted: J explains instead of moving.
    await t.press('g', 'n');
    await t.waitFor((f) => f.split('\n')[1]?.includes('No date') === true);
    await t.press('J');
    await t.waitFor((f) => f.includes('Sorted view'));
  });

  it('Delete removes a task to the Trash and u restores it', async () => {
    const { user, cli } = await setup();
    const task = await addTask(user, { title: 'Disposable' });
    const t = await tui(cli);
    await t.waitFor((f) => f.includes('Disposable'));
    await t.press(KEY.delete);
    await t.waitFor((f) => f.includes('Deleted “Disposable”') && !f.includes('○ Disposable'));
    const deletedAt = async () =>
      (await user.api<{ deletedAt?: number | null }>('GET', `/api/v1/tasks/${task.id}`)).data
        .deletedAt ?? null;
    expect(await eventually(deletedAt, (v) => v !== null)).not.toBeNull();
    await t.press('u');
    await t.waitFor((f) => f.includes('○ Disposable'));
    expect(await eventually(deletedAt, (v) => v === null)).toBeNull();
  });
});

describe('TUI: detail view and search', () => {
  it('o opens the details (full screen when narrow, split from 120 columns); e edits in $EDITOR', async () => {
    const { user, cli } = await setup();
    const parent = await addTask(user, {
      title: 'Plan trip',
      description: '# Packing\n- passport',
    });
    await user.api('POST', '/api/v1/orgs/personal/tasks', {
      title: 'Book hotel',
      parentId: parent.id,
    });
    await user.api('POST', `/api/v1/tasks/${parent.id}/comments`, { body: 'Remember the visa' });
    const editors: string[][] = [];
    const t = await tui(cli, {
      io: {
        runEditor: async (argv, file) => {
          editors.push([...argv]);
          writeFileSync(file, 'Bring snacks');
          return 0;
        },
      },
    });
    await t.waitFor((f) => f.includes('Plan trip'));
    await t.press('o');
    let frame = await t.waitFor((f) => f.includes('Remember the visa'));
    // 100 columns: the details take the list area.
    expect(frame).toContain('Packing');
    expect(frame).toContain('• passport');
    expect(frame).toMatch(/Subtasks 0\/1/);
    expect(frame).toContain('○ Book hotel');
    expect(frame).toMatch(/You created this task/);
    expect(frame).not.toContain('▾ Inbox');
    t.resize(140, 30);
    frame = await t.waitFor((f) => f.split('\n')[0]?.length === 140 && f.includes('▾ Inbox'));
    expect(frame).toMatch(/▾ Inbox \(1\)\s+│ #\d+ ○ Plan trip/);
    expect(frame).toMatch(/› ○ Plan trip\s+▸ 0\/1 ≡ ✎1 │ Group/);
    await t.press('e');
    await t.waitFor((f) => f.includes('Bring snacks'));
    expect(editors[0]?.[0]).toBe('vi');
    const description = async () =>
      (await user.api<TaskJson>('GET', `/api/v1/tasks/${parent.id}`)).data.description;
    expect(await eventually(description, (v) => v === 'Bring snacks')).toBe('Bring snacks');
    await t.press('o');
    await t.waitFor((f) => !f.includes('Bring snacks'));
  });

  it('/ searches the org and Esc goes back to the list', async () => {
    const { user, cli } = await setup();
    await addTask(user, { title: 'Quarterly report' });
    await addTask(user, { title: 'Groceries' });
    const t = await tui(cli);
    await t.waitFor((f) => f.includes('Groceries'));
    await t.press('/');
    await t.type('quarterly');
    let frame = await t.waitFor((f) => f.includes('/ quarterly') && !f.includes('Groceries'));
    await t.press(KEY.enter);
    frame = await t.waitFor((f) => selectedRow(f)?.includes('Quarterly report') === true);
    expect(frame.split('\n')[1]).toContain('/ quarterly');
    await t.press(KEY.esc);
    await t.waitFor((f) => f.includes('Groceries') && f.includes('Quarterly report'));
  });
});

describe('TUI: live updates and failures', () => {
  it('AC-9.1 a change made through the API (as the web would) appears in the TUI within 2 s', async () => {
    const { user, cli } = await setup();
    const [task] = await addTasks(user, 'Initial title', 'Below it');
    if (task === undefined) throw new Error('no task');
    const t = await tui(cli);
    await t.waitFor((f) => f.includes('Initial title') && f.includes('● synced'));
    await t.press('j');
    await t.waitFor((f) => selectedRow(f)?.includes('Below it') === true);
    const started = Date.now();
    // The browser session: a rename and a new task.
    await user.api('PATCH', `/api/v1/tasks/${task.id}`, { title: 'Renamed on the web' });
    await user.api('POST', '/api/v1/orgs/personal/tasks', { title: 'Added on the web' });
    await t.waitFor(
      (f) => f.includes('Renamed on the web') && f.includes('Added on the web'),
      2_000,
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    // The selection stayed on the same task.
    expect(selectedRow(t.frame())).toContain('Below it');
  });

  it('offline: the status says so, a change fails with a retry prompt, and r sends it again', async () => {
    const { user, cli } = await setup();
    const task = await addTask(user, { title: 'Flaky' });
    let offline = false;
    const t = await tui(cli, {
      io: {
        fetch: (input, init) =>
          offline
            ? Promise.reject(new TypeError('fetch failed'))
            : globalThis.fetch(input as Request, init),
      },
    });
    await t.waitFor((f) => f.includes('Flaky') && f.includes('● synced'));
    offline = true;
    await t.press('x');
    let frame = await t.waitFor((f) => f.includes('Couldn’t save'));
    expect(frame).toMatch(/r retry {2}Esc dismiss/);
    expect(frame.split('\n')[0]).toContain('○ offline');
    offline = false;
    await t.press('r');
    frame = await t.waitFor((f) => f.includes('Completed “Flaky”'));
    const completedAt = async () =>
      (await user.api<TaskJson>('GET', `/api/v1/tasks/${task.id}`)).data.completedAt;
    expect(await eventually(completedAt, (v) => v !== null)).not.toBeNull();
  });

  it('never prints control or bidi characters from user content', async () => {
    const { user, cli } = await setup();
    await addTask(user, {
      title: 'Evil \u001b[2J\u001b]0;pwned\u0007 title \u202egnp.exe',
      description: 'Line \u001b[31mred\u001b[0m',
    });
    const t = await tui(cli);
    await t.waitFor((f) => f.includes('Evil'));
    await t.press('o');
    const frame = await t.waitFor((f) => f.includes('Line') && f.includes('red'));
    expect(frame).not.toMatch(UNSAFE_CHARS);
  });

  it('[P2] a /me with a timezone dates cannot use is never installed (SSE invalidation)', async () => {
    const { user, cli } = await setup();
    await addTask(user, { title: 'Steady' });
    let hostile = false;
    let reloaded = false;
    const t = await tui(cli, {
      io: {
        fetch: async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);
          const response = await globalThis.fetch(request);
          if (!hostile || new URL(request.url).pathname !== '/api/v1/me') return response;
          const me = (await response.json()) as Record<string, unknown>;
          reloaded = true;
          return Response.json({ ...me, timezone: 'UTC\u001b]52;c;QUJD\u0007' });
        },
      },
    });
    await t.waitFor((f) => f.includes('Steady') && f.includes('● synced'));
    const before = t.session.controller.getState().me.timezone;
    hostile = true;
    t.session.controller.onSseMessage({
      event: 'invalidate',
      data: JSON.stringify({ org: null, keys: [['me']], origin: null }),
    } as never);
    await eventually(
      async () => reloaded,
      (v) => v,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(t.session.controller.getState().me.timezone).toBe(before);
    // Everything that derives the list (a key, the minute clock) still works.
    await t.press('j');
    expect(t.frame()).toContain('Steady');
    expect(t.frame()).not.toMatch(UNSAFE_CHARS);
  });

  it('q quits', async () => {
    const { cli } = await setup();
    const t = await tui(cli);
    await t.waitFor((f) => f.includes('synced'));
    let quit = false;
    t.session.controller.attach({ exit: () => (quit = true) });
    await t.press('q');
    expect(quit).toBe(true);
  });
});

/** A fetch for the TUI that can delay or lose answers to matching requests. */
function controlledFetch(rules: {
  delay?: (request: Request) => number;
  lose?: (request: Request) => boolean;
  offline?: () => boolean;
}): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (rules.offline?.()) throw new TypeError('fetch failed');
    const ms = rules.delay?.(request) ?? 0;
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
    const response = await globalThis.fetch(request);
    if (rules.lose?.(request)) throw new TypeError('connection reset');
    return response;
  }) as typeof fetch;
}

const isWrite = (request: Request, path: RegExp) =>
  request.method !== 'GET' && path.test(new URL(request.url).pathname);

async function sharedOrg(user: TestUser): Promise<string> {
  const slug = `acme-${seq}`;
  const { status } = await user.api('POST', '/api/v1/orgs', { name: 'Acme', slug });
  expect(status).toBe(201);
  return slug;
}

describe('TUI: review round 1', () => {
  it('the details follow the selection when it moves on its own (a completed row leaves)', async () => {
    const { user, cli } = await setup();
    const [first, second] = await addTasks(user, 'First', 'Second');
    const t = await tui(cli);
    await t.waitFor((f) => f.includes('Second'));
    await t.press('o');
    await t.waitFor((f) => /│ #\d+ ○ First/.test(f));
    await t.press('x');
    // After the completion hold the row leaves, the selection moves to Second: so do the details.
    await t.waitFor((f) => /│ #\d+ ○ Second/.test(f), 4_000);
    const state = t.session.controller.getState();
    expect(state.selected).toBe(second?.id);
    expect(state.detail?.taskId).toBe(second?.id);
    expect(first?.id).not.toBe(second?.id);
  });

  it('r sends a change whose answer was lost with the same Idempotency-Key: no duplicate', async () => {
    const { user, cli } = await setup();
    let lose = true;
    const t = await tui(cli, {
      io: {
        fetch: controlledFetch({
          lose: (r) => {
            const hit = lose && isWrite(r, /\/orgs\/[^/]+\/tasks$/);
            if (hit) lose = false;
            return hit;
          },
        }),
      },
    });
    await t.waitFor((f) => f.includes('synced'));
    await t.press('n');
    await t.type('Only once');
    await t.press(KEY.esc);
    await t.waitFor((f) => f.includes('Couldn’t save'));
    await t.press('r');
    await t.waitFor((f) => f.includes('○ Only once') && !f.includes('Couldn’t save'));
    const list = await eventually(
      () => myList(user),
      (l) => l.tasks.some((x) => x.title === 'Only once'),
    );
    expect(list.tasks.filter((x) => x.title === 'Only once')).toHaveLength(1);
  });

  it('typing on while a draft is saved goes into the next draft, not into shortcuts', async () => {
    const { user, cli } = await setup();
    const t = await tui(cli, {
      io: {
        fetch: controlledFetch({ delay: (r) => (isWrite(r, /\/orgs\/[^/]+\/tasks$/) ? 400 : 0) }),
      },
    });
    await t.waitFor((f) => f.includes('synced'));
    let quit = false;
    t.session.controller.attach({ exit: () => (quit = true) });
    await t.press('n');
    await t.type('Slow one');
    await t.press(KEY.enter);
    // Typed before the first save returns; contains q, which would quit in Navigate mode.
    await t.type('quick next');
    await t.press(KEY.esc);
    await t.waitFor((f) => f.includes('○ Slow one') && f.includes('○ quick next'), 4_000);
    expect(quit).toBe(false);
    // From the first header (Today: the empty Inbox is hidden), at the top of that group.
    expect(
      await eventually(
        () => titlesIn(user, 'Today'),
        (v) => v.length === 2,
      ),
    ).toEqual(['Slow one', 'quick next']);
  });

  it('pickers and the title editor show over the full-screen details', async () => {
    const { user, cli } = await setup();
    await addTask(user, { title: 'Detailed', description: 'Some text' });
    const t = await tui(cli);
    await t.waitFor((f) => f.includes('Detailed'));
    await t.press('o');
    await t.waitFor((f) => f.includes('Some text'));
    await t.press('d');
    await t.waitFor((f) => f.includes('Date ▏') && !f.includes('Some text'));
    await t.press(KEY.esc);
    await t.waitFor((f) => f.includes('Some text'));
    await t.press(KEY.enter);
    await t.waitFor((f) => f.includes('Detailed▏'));
    await t.press(KEY.esc);
    await t.waitFor((f) => f.includes('Some text'));
  });

  it('stale search answers are dropped after Esc, a newer search or an org switch', async () => {
    const { user, cli } = await setup();
    await sharedOrg(user);
    await addTasks(user, 'Alpha report', 'Beta notes');
    const t = await tui(cli, {
      io: {
        fetch: controlledFetch({
          delay: (r) => (new URL(r.url).pathname === '/api/v1/search' ? 500 : 0),
        }),
      },
    });
    await t.waitFor((f) => f.includes('Beta notes'));
    // Esc while the search is on its way: it never comes back.
    await t.press('/');
    await t.type('alpha');
    await t.press(KEY.enter, KEY.esc);
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(t.session.controller.getState().view).toBe('my');
    expect(t.frame()).toContain('Beta notes');
    // An org switch while a search is on its way: Acme shows, without Personal's results.
    await t.press('/');
    await t.type('alpha');
    await t.press(KEY.enter, '2');
    await t.waitFor((f) => f.includes('rooster ─ Acme'));
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(t.session.controller.getState().view).toBe('my');
    expect(t.frame()).not.toContain('Alpha report');
  });

  it('adding from the header of a group collapsed in an earlier session opens the group', async () => {
    const { user, cli } = await setup();
    const today = (await myList(user)).groups.find((g) => g.name === 'Today');
    await user.api('PATCH', `/api/v1/groups/${today?.id}`, { collapsed: true });
    const t = await tui(cli);
    await t.waitFor((f) => f.includes('› ▸ Today (0)'));
    await t.press('n');
    await t.type('Visible');
    await t.press(KEY.esc);
    await t.waitFor((f) => f.includes('▾ Today (1)') && f.includes('○ Visible'));
  });

  it('a change answered after an org switch leaves no undo in the new org', async () => {
    const { user, cli } = await setup();
    await sharedOrg(user);
    const [task] = await addTasks(user, 'Alpha');
    const t = await tui(cli, {
      io: {
        fetch: controlledFetch({ delay: (r) => (isWrite(r, /\/complete$/) ? 400 : 0) }),
      },
    });
    await t.waitFor((f) => f.includes('Alpha'));
    await t.press('x', '2');
    await t.waitFor((f) => f.includes('rooster ─ Acme'));
    const completedAt = async () =>
      (await user.api<TaskJson>('GET', `/api/v1/tasks/${task?.id}`)).data.completedAt;
    expect(await eventually(completedAt, (v) => v !== null)).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await t.press('u');
    await t.waitFor((f) => f.includes('Nothing to undo'));
    expect(await completedAt()).not.toBeNull();
  });

  it('a change that failed in one org is not retried by r in another', async () => {
    const { user, cli } = await setup();
    await sharedOrg(user);
    const [task] = await addTasks(user, 'Alpha');
    let offline = false;
    const t = await tui(cli, { io: { fetch: controlledFetch({ offline: () => offline }) } });
    await t.waitFor((f) => f.includes('Alpha') && f.includes('● synced'));
    offline = true;
    await t.press('x');
    await t.waitFor((f) => f.includes('Couldn’t save'));
    offline = false;
    await t.press('2');
    await t.waitFor((f) => f.includes('rooster ─ Acme'));
    await t.press('r');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const { data } = await user.api<TaskJson>('GET', `/api/v1/tasks/${task?.id}`);
    expect(data.completedAt).toBeNull();
  });

  it('r after a definitive rejection sends the rejected write with a new key, not the cached answer', async () => {
    const { user, cli } = await setup();
    const [task] = await addTasks(user, 'Alpha', 'Beta');
    const t = await tui(cli);
    await t.waitFor((f) => f.includes('Alpha'));
    // No live stream: the TUI keeps showing Alpha after the web deletes it.
    t.session.sse.stop();
    await user.api('DELETE', `/api/v1/tasks/${task?.id}`);
    await t.press('x');
    await t.waitFor((f) => f.includes('Couldn’t save'));
    // Restored on the web; the cached rejection must not be replayed.
    await user.api('POST', `/api/v1/tasks/${task?.id}/restore`);
    await t.press('r');
    const completedAt = async () =>
      (await user.api<TaskJson>('GET', `/api/v1/tasks/${task?.id}`)).data.completedAt;
    expect(await eventually(completedAt, (v) => v !== null)).not.toBeNull();
    expect(t.frame()).not.toContain('Couldn’t save');
  });

  it('a stale create finishing after an org switch keeps the newer draft’s typing', async () => {
    const { user, cli } = await setup();
    const slug = await sharedOrg(user);
    const t = await tui(cli, {
      io: {
        fetch: controlledFetch({ delay: (r) => (isWrite(r, /\/orgs\/[^/]+\/tasks$/) ? 500 : 0) }),
      },
    });
    await t.waitFor((f) => f.includes('synced'));
    let quit = false;
    t.session.controller.attach({ exit: () => (quit = true) });
    await t.press('n');
    await t.type('In personal');
    await t.press(KEY.enter);
    // As if a live update moved the session to another org while the save is on its way.
    const acme = t.session.controller.getState().me.orgs.find((o) => o.slug === slug);
    if (acme === undefined) throw new Error('no org');
    await t.session.controller.switchOrg(acme);
    await t.waitFor((f) => f.includes('rooster ─ Acme'));
    await t.press('n');
    await t.type('In acme');
    await t.press(KEY.enter);
    // The first save finishes while this is typed; the text must reach the next draft.
    await t.type('quick note');
    await t.press(KEY.esc);
    await t.waitFor((f) => f.includes('○ In acme') && f.includes('○ quick note'), 4_000);
    expect(quit).toBe(false);
    const { data } = await user.api<{ tasks: TaskJson[] }>('GET', `/api/v1/orgs/${slug}/my-list`);
    expect(data.tasks.map((x) => x.title).sort()).toEqual(['In acme', 'quick note']);
  });
});
