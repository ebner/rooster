import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createRoosterClient } from '@rooster/api-client';
import { addDays, todayIn } from '@rooster/core/dates';
import { createRoosterMcpServer } from '@rooster/mcp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { stripAnsi } from '../src/output/color.ts';
import { runCli } from '../src/run.ts';
import { type CliHarness, cliHarness, fakeIo } from './support/fake-io.ts';
import { type RoosterServer, startServer, type TestUser } from './support/rooster-server.ts';
import { KEY, openTui, type TuiHarness } from './support/tui.ts';

/**
 * ADR 0068: an open, top-level recurring task whose day hasn't come is held out of its group in
 * My tasks and listed under Upcoming, in `rooster ls`, the TUI and the MCP tools alike.
 */

interface TaskJson {
  id: string;
  seq: number;
  title: string;
  dueDate: string | null;
  completedAt: number | null;
  placement: { groupId: string; position: string } | null;
  upcoming?: boolean;
}

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

const DAY_MS = 86_400_000;
const END = '\u001b[F';
const HOME = '\u001b[H';

interface Seeded {
  user: TestUser;
  cli: CliHarness;
  day: string;
  weekly: string;
  tasks: Record<'standup' | 'dentist' | 'plants' | 'gym' | 'review' | 'water', TaskJson>;
}

/**
 * A user with a group "Weekly" holding, in this order: Plants (weekly, due in 3 days), Standup
 * (daily, due today), Dentist (once, due in 3 days); in the Inbox: Gym (repeating, starts in 2
 * days) and Review (repeating, due tomorrow); and Water, a subtask of Plants.
 */
async function seed(): Promise<Seeded> {
  seq += 1;
  const user = await server.user(`upcoming-${seq}@example.com`, 'Ada');
  const { token } = await user.token({
    scopes: ['tasks:read', 'tasks:write', 'tasks:delete', 'groups:write'] as never,
  });
  const cli = cliHarness();
  const login = await cli.run(['login', '--with-token', '--server', server.url], { stdin: token });
  expect(login.code).toBe(0);
  const { data: me } = await user.api<{ timezone: string }>('GET', '/api/v1/me');
  const day = todayIn(me.timezone, Date.now());
  const group = await user.api<{ group: { id: string } }>('POST', '/api/v1/orgs/personal/groups', {
    name: 'Weekly',
  });
  expect(group.status).toBe(201);
  const weekly = group.data.group.id;
  const add = async (body: Record<string, unknown>) => {
    const { status, data } = await user.api<TaskJson>('POST', '/api/v1/orgs/personal/tasks', body);
    expect(status).toBe(201);
    return data;
  };
  const plants = await add({
    title: 'Plants',
    groupId: weekly,
    dueDate: addDays(day, 3),
    recurrence: 'FREQ=WEEKLY',
  });
  const standup = await add({
    title: 'Standup',
    groupId: weekly,
    dueDate: day,
    recurrence: 'FREQ=DAILY',
  });
  const dentist = await add({ title: 'Dentist', groupId: weekly, dueDate: addDays(day, 3) });
  const gym = await add({
    title: 'Gym',
    startDate: addDays(day, 2),
    dueDate: addDays(day, 5),
    recurrence: 'FREQ=WEEKLY',
  });
  const review = await add({ title: 'Review', dueDate: addDays(day, 1), recurrence: 'FREQ=DAILY' });
  const water = await add({ title: 'Water', parentId: plants.id });
  return {
    user,
    cli,
    day,
    weekly,
    tasks: { standup, dentist, plants, gym, review, water },
  };
}

/**
 * The line of the section's header ("↻ Recurring"). New users also get a default group named
 * "Upcoming"; it never matches, since the section's header has the ↻ and is the last one.
 */
function sectionAt(lines: readonly string[]): number {
  let at = -1;
  lines.forEach((line, i) => {
    if (/[▸▾] ↻ Recurring \(/.test(line)) at = i;
  });
  return at;
}

const lineOf = (stdout: string, title: string) =>
  stdout.split('\n').find((line) => line.includes(` ${title}`)) ?? '';

describe('ADR 0068: rooster ls', () => {
  it('holds Upcoming tasks back with a hint; --upcoming lists them last, by day, naming their group', async () => {
    const { user, cli } = await seed();
    // New users have a group named "Upcoming"; its tasks are an ordinary group's.
    const { data: list } = await user.api<{ groups: { id: string; name: string }[] }>(
      'GET',
      '/api/v1/orgs/personal/my-list',
    );
    const own = list.groups.find((g) => g.name === 'Upcoming');
    expect(own).toBeDefined();
    await user.api('POST', '/api/v1/orgs/personal/tasks', { title: 'Someday', groupId: own?.id });
    const plain = await cli.run(['ls']);
    expect(plain.code).toBe(0);
    expect(plain.stderr).toBe('');
    const text = stripAnsi(plain.stdout);
    expect(text).toContain('Standup');
    expect(text).toContain('Dentist');
    for (const title of ['Plants', 'Gym', 'Review']) expect(text).not.toContain(title);
    // The group count leaves them out too.
    expect(text).toContain('Weekly (2)');
    expect(text).toContain('Upcoming (1)');
    expect(text).toContain('Someday');
    expect(text.trimEnd().split('\n').at(-1)).toBe(
      '3 tasks in Recurring not shown (add --upcoming)',
    );

    const all = await cli.run(['ls', '--upcoming', '--subtasks']);
    expect(all.code).toBe(0);
    const lines = stripAnsi(all.stdout).trimEnd().split('\n');
    const at = lines.indexOf('Recurring (3)');
    expect(at).toBeGreaterThan(lines.findIndex((l) => l.includes('Dentist')));
    // By day: Review tomorrow, Gym starting in 2 days, Plants in 3 (its subtask under it).
    expect(lines.slice(at + 1).map((l) => /○ (\s*\S+)/.exec(l)?.[1])).toEqual([
      'Review',
      'Gym',
      'Plants',
      '  Water',
    ]);
    expect(lineOf(all.stdout, 'Plants')).toMatch(/Plants\s+▸ 0\/1 Weekly ↻/);
    expect(stripAnsi(all.stdout)).not.toContain('not shown');
  });

  it('--json keeps every task in group order and marks the held ones; --quiet follows the text', async () => {
    const { cli, tasks } = await seed();
    const result = await cli.run(['ls', '--json', '--subtasks']);
    expect(result.code).toBe(0);
    const json = JSON.parse(result.stdout) as { tasks: TaskJson[] };
    expect(json.tasks.map((t) => [t.title, t.upcoming])).toEqual([
      ['Review', true],
      ['Gym', true],
      ['Plants', true],
      ['Water', false],
      ['Standup', false],
      ['Dentist', false],
    ]);

    const quiet = await cli.run(['ls', '--quiet']);
    expect(quiet.stdout.trim().split('\n')).toEqual([
      String(tasks.standup.seq),
      String(tasks.dentist.seq),
    ]);
    const quietAll = await cli.run(['ls', '--quiet', '--upcoming']);
    expect(quietAll.stdout.trim().split('\n')).toEqual(
      [tasks.standup, tasks.dentist, tasks.review, tasks.gym, tasks.plants].map((t) =>
        String(t.seq),
      ),
    );
  });

  it('--group narrows Upcoming too; the views refuse --upcoming', async () => {
    const { cli } = await seed();
    const weekly = stripAnsi((await cli.run(['ls', '--group', 'Weekly'])).stdout);
    expect(weekly).toContain('1 task in Recurring not shown (add --upcoming)');
    const shown = stripAnsi((await cli.run(['ls', '--group', 'Weekly', '--upcoming'])).stdout);
    expect(shown).toContain('Recurring (1)');
    expect(shown).toContain('Plants');
    expect(shown).not.toContain('Gym');

    const view = await cli.run(['ls', 'today', '--upcoming']);
    expect(view.code).toBe(2);
    expect(view.stderr).toContain('--upcoming works with My tasks only');
    // The smart views go by date: Review is in the week, held back or not.
    expect(stripAnsi((await cli.run(['week'])).stdout)).toContain('Review');
    expect((await cli.run(['today', '--upcoming'])).code).toBe(2);
  });

  it('on its day a task is back in its group, at its own position', async () => {
    const { cli } = await seed();
    // The same signed-in home, three days later.
    const io = fakeIo(cli.home, { now: () => Date.now() + 3 * DAY_MS });
    io.env = { ...io.env, ...cli.env };
    expect(await runCli(['ls'], io)).toBe(0);
    const text = stripAnsi(io.out.join(''));
    expect(text).not.toContain('Recurring');
    expect(text).toContain('Weekly (3)');
    const order = ['Plants', 'Standup', 'Dentist'].map((title) => text.indexOf(` ${title}`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe('ADR 0068: the TUI', () => {
  async function tui(cli: CliHarness, now?: () => number): Promise<TuiHarness> {
    const harness = await openTui(cli, now === undefined ? {} : { io: { now } });
    open.push(harness);
    return harness;
  }

  it('ends My tasks with a collapsed Upcoming; → opens it; rows complete, but never move', async () => {
    const { user, cli, tasks } = await seed();
    const t = await tui(cli);
    const first = await t.waitFor((f) => f.includes('Standup') && f.includes('▸ ↻ Recurring (3)'));
    expect(first).not.toContain('Plants');
    expect(first).toContain('Weekly (2)');

    await t.press(END, KEY.right); // the last line is Upcoming
    const opened = await t.waitFor((f) => f.includes('▾ ↻ Recurring (3)') && f.includes('Plants'));
    const rows = opened.split('\n');
    const upcomingAt = sectionAt(rows);
    expect(rows[upcomingAt]).toContain('▾ ↻ Recurring (3)');
    const titles = ['Review', 'Gym', 'Plants'].map((title) =>
      rows.findIndex((l, i) => i > upcomingAt && l.includes(` ${title}`)),
    );
    expect(titles.every((i) => i > upcomingAt)).toBe(true);
    expect(titles).toEqual([...titles].sort((a, b) => a - b));
    // Plants names the group it goes back to.
    expect(rows[titles[2] as number]).toMatch(/Plants\s+Weekly/);

    // ← closes it again; Enter toggles it like a group header.
    await t.press(KEY.left);
    await t.waitFor((f) => f.includes('▸ ↻ Recurring (3)'));
    await t.press(KEY.enter);
    await t.waitFor((f) => f.includes('▾ ↻ Recurring (3)'));

    // j onto Review: J, ] and m don't move it.
    await t.press('j');
    await t.waitFor((f) => /› .*Review/.test(f));
    const position = async () =>
      (await user.api<TaskJson>('GET', `/api/v1/tasks/${tasks.review.id}`)).data.placement;
    const before = await position();
    for (const key of ['J', ']', 'm']) {
      await t.press(key);
      await t.waitFor((f) => f.includes('Tasks in Recurring can’t be moved'));
      await t.press(KEY.esc);
      await t.waitFor((f) => !f.includes('Tasks in Recurring can’t be moved'));
    }
    expect(await position()).toEqual(before);

    // x completes it, and the row stays where it was (in Upcoming) while it is held.
    await t.press('x');
    const done = await t.waitFor((f) => /✓ Review/.test(f));
    const lines = done.split('\n');
    expect(lines.findIndex((l) => /✓ Review/.test(l))).toBeGreaterThan(sectionAt(lines));
    await t.waitFor((f) => f.includes('Completed “Review”; next:'));
    const reviewed = await user.api<TaskJson>('GET', `/api/v1/tasks/${tasks.review.id}`);
    expect(reviewed.data.completedAt).toEqual(expect.any(Number));
  });

  it('n from Upcoming adds at the top of the list; a date that sends a task there says so', async () => {
    const { user, cli, day, tasks } = await seed();
    const t = await tui(cli);
    await t.waitFor((f) => f.includes('▸ ↻ Recurring (3)'));
    await t.press(END, 'n'); // from the Upcoming header
    await t.type('Fresh');
    await t.press(KEY.esc);
    await t.waitFor((f) => f.includes('Fresh'));
    const list = async () =>
      (
        await user.api<{ groups: { id: string; kind: string }[]; tasks: TaskJson[] }>(
          'GET',
          '/api/v1/orgs/personal/my-list',
        )
      ).data;
    const data = await list();
    const inbox = data.groups.find((g) => g.kind === 'inbox')?.id;
    const fresh = data.tasks.find((x) => x.title === 'Fresh');
    expect(fresh?.placement?.groupId).toBe(inbox);
    const inInbox = data.tasks
      .filter((x) => x.placement?.groupId === inbox)
      .sort((a, b) => ((a.placement?.position ?? '') < (b.placement?.position ?? '') ? -1 : 1));
    expect(inInbox[0]?.title).toBe('Fresh');

    // Standup (due today, daily) gets a later date: it leaves Weekly for Upcoming.
    await t.press(HOME);
    let frame = t.frame();
    for (let i = 0; i < 10 && !/› .*Standup/.test(frame); i++) {
      await t.press('j');
      frame = t.frame();
    }
    expect(frame).toMatch(/› .*Standup/);
    await t.press('d');
    await t.type('in 4 days');
    await t.press(KEY.enter);
    await t.waitFor(
      (f) =>
        f.includes('“Standup” is in Recurring; back in its group:') &&
        f.includes('↻ Recurring (4)'),
    );
    const moved = await user.api<TaskJson>('GET', `/api/v1/tasks/${tasks.standup.id}`);
    expect(moved.data.dueDate).toBe(addDays(day, 4));
    // The placement is untouched: only the date changed.
    expect(moved.data.placement).toEqual(tasks.standup.placement);
  });

  it('the minute clock brings a task back to its group on its day', async () => {
    const { cli } = await seed();
    let clock = Date.now();
    const t = await tui(cli, () => clock);
    await t.waitFor((f) => f.includes('▸ ↻ Recurring (3)') && f.includes('Weekly (2)'));
    clock += 3 * DAY_MS;
    await t.session.controller.refresh();
    const later = await t.waitFor((f) => f.includes('Weekly (3)'));
    // The section is gone; the user's own (empty) group named Upcoming is still there.
    expect(later).not.toContain('↻ Recurring');
    expect(later).toContain('▾ Upcoming (0)');
    expect(later).toContain('Plants');
  });
});

describe('ADR 0068: MCP (in process, over a PAT)', () => {
  it('list_tasks marks held tasks and lists them last; the resource has an Upcoming part', async () => {
    const { user, tasks } = await seed();
    const { token } = await user.token({ scopes: ['tasks:read'] as never, name: 'mcp' });
    const mcpServer = createRoosterMcpServer({
      client: createRoosterClient({ baseUrl: server.url, token }),
      listing: { mode: 'granted', scopes: ['tasks:read'] },
      defaultOrg: 'personal',
      instanceUrl: server.url,
      version: '1.10.0',
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(b);
    const mcp = new Client({ name: 'upcoming', version: '1.0.0' });
    await mcp.connect(a);
    try {
      const result = (await mcp.callTool({ name: 'list_tasks', arguments: {} })) as {
        content: { text: string }[];
        structuredContent: { tasks: { ref: string; title: string; upcoming?: boolean }[] };
      };
      const rows = result.structuredContent.tasks;
      expect(rows.map((r) => [r.title, r.upcoming === true])).toEqual([
        ['Standup', false],
        ['Dentist', false],
        ['Review', true],
        ['Gym', true],
        ['Plants', true],
      ]);
      expect(result.content[0]?.text).toContain('(the last 3 in Recurring until their day)');

      const today = (await mcp.callTool({ name: 'list_tasks', arguments: { view: 'today' } })) as {
        structuredContent: { tasks: { title: string }[] };
      };
      expect(today.structuredContent.tasks.map((r) => r.title)).toEqual(['Standup']);

      const slug = (
        await user.api<{ orgs: { slug: string; isPersonal: boolean }[] }>('GET', '/api/v1/me')
      ).data.orgs.find((o) => o.isPersonal)?.slug;
      const read = await mcp.readResource({ uri: `rooster://${slug}/my` });
      const text = (read.contents[0] as { text: string }).text;
      const upcomingAt = text.indexOf('## Recurring (3)');
      expect(upcomingAt).toBeGreaterThan(text.indexOf('## Weekly (2)'));
      // The user's own group named Upcoming is a group like any other, apart from the section.
      expect(text).toContain('## Upcoming (0)');
      expect(text.slice(upcomingAt)).toMatch(/Plants · due \S+ · back in Weekly/);
      expect(text.slice(0, upcomingAt)).not.toContain('Plants');
      expect(tasks.plants.placement?.groupId).toBeDefined();
    } finally {
      await mcp.close();
    }
  });
});
