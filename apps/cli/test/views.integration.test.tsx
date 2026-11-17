import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createRoosterClient } from '@rooster/api-client';
import { addDays, todayIn } from '@rooster/core/dates';
import { selectSavedView } from '@rooster/core/saved-views';
import type { SavedViewQuery, Task } from '@rooster/core/schemas';
import { createRoosterMcpServer } from '@rooster/mcp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { stripAnsi } from '../src/output/color.ts';
import { type CliHarness, cliHarness } from './support/fake-io.ts';
import { type RoosterServer, startServer, type TestUser } from './support/rooster-server.ts';
import { openTui, type TuiHarness } from './support/tui.ts';

/**
 * Phase 13 (ADR 0073 B12, AC-13.5): `rooster view ls`, `rooster ls --view Juniper`, MCP
 * `list_views` / `list_tasks {view: "Juniper"}` and the TUI's view bar, against a real server:
 * the same rows in the same order as the web, which groups `GET /views/:id/tasks` with core
 * `selectSavedView`.
 */

interface TaskJson {
  id: string;
  orgId: string;
  seq: number;
  title: string;
  assigneeId: string | null;
  tagIds: string[];
  completedAt: number | null;
}
interface ViewJson {
  id: string;
  name: string;
  shared: boolean;
  query: SavedViewQuery;
  openCount: number;
}
interface MeJson {
  id: string;
  locale: string;
  timezone: string;
  orgs: { id: string; slug: string; isPersonal: boolean }[];
}

let server: RoosterServer;
let seq = 0;
let tuis: TuiHarness[] = [];

beforeAll(async () => {
  server = await startServer();
});
afterEach(() => {
  for (const tui of tuis) tui.close();
  tuis = [];
});
afterAll(async () => {
  await server?.close();
});

interface Seeded {
  ada: TestUser;
  bo: TestUser;
  token: string;
  cli: CliHarness;
  orgId: string;
  slug: string;
  juniper: ViewJson;
  tasks: Record<string, TaskJson>;
}

/**
 * Kestrel with Ada, Bo and Cy: a shared project view "Juniper" (#juniper) with tasks for each
 * of them, an unassigned one, a subtask, a completed one and one without the tag; Ada's own
 * private view "Mine".
 */
async function seed(): Promise<Seeded> {
  seq += 1;
  const ada = await server.user(`views-ada-${seq}@example.com`, 'Ada');
  const bo = await server.user(`views-bo-${seq}@example.com`, 'Bo');
  const cy = await server.user(`views-cy-${seq}@example.com`, 'Cy');
  const { token } = await ada.token({
    scopes: ['tasks:read', 'tasks:write', 'tasks:assign'] as never,
  });
  const cli = cliHarness();
  const login = await cli.run(['login', '--with-token', '--server', server.url], { stdin: token });
  expect(login.code, login.stderr).toBe(0);
  const slug = `kestrel-${seq}`;
  const created = await ada.api<{ id: string }>('POST', '/api/v1/orgs', { name: 'Kestrel', slug });
  expect(created.status).toBe(201);
  const orgId = created.data.id;
  for (const member of [bo, cy]) {
    const invite = await ada.api<{ url: string }>('POST', `/api/v1/orgs/${orgId}/invites`, {
      role: 'member',
    });
    const accepted = await member.api(
      'POST',
      `/api/v1/invites/${invite.data.url.split('/invite/')[1]}/accept`,
    );
    expect(accepted.status).toBe(200);
  }
  const me = (await ada.api<MeJson>('GET', '/api/v1/me')).data;
  const day = todayIn(me.timezone, Date.now());
  const add = async (body: Record<string, unknown>) => {
    const { status, data } = await ada.api<TaskJson>('POST', `/api/v1/orgs/${orgId}/tasks`, body);
    expect(status, JSON.stringify(data)).toBe(201);
    return data;
  };
  const tasks: Record<string, TaskJson> = {};
  tasks.cyLater = await add({
    title: 'Cy later',
    tagNames: ['juniper'],
    assigneeId: cy.userId,
    dueDate: addDays(day, 5),
  });
  tasks.adaUndated = await add({ title: 'Ada undated', tagNames: ['juniper'] });
  tasks.boSoon = await add({
    title: 'Bo soon',
    tagNames: ['juniper'],
    assigneeId: bo.userId,
    dueDate: addDays(day, 1),
  });
  tasks.adaToday = await add({ title: 'Ada today', tagNames: ['juniper'], dueDate: day });
  tasks.nobody = await add({ title: 'Nobody’s', tagNames: ['juniper'], assigneeId: null });
  tasks.untagged = await add({ title: 'Not Juniper', assigneeId: bo.userId });
  tasks.sub = await add({
    title: 'Juniper subtask',
    tagNames: ['juniper'],
    parentId: tasks.untagged.id,
    assigneeId: cy.userId,
  });
  tasks.done = await add({ title: 'Done Juniper', tagNames: ['juniper'], dueDate: day });
  expect(
    (await ada.api('POST', `/api/v1/tasks/${tasks.done.id}/complete`, { completed: true })).status,
  ).toBe(200);
  const tagId = tasks.adaToday.tagIds[0] as string;
  const view = async (body: Record<string, unknown>) => {
    const { status, data } = await ada.api<ViewJson>('POST', `/api/v1/orgs/${orgId}/views`, body);
    expect(status, JSON.stringify(data)).toBe(201);
    return data;
  };
  const juniper = await view({ name: 'Juniper', shared: true, query: { tags: [tagId] } });
  await view({ name: 'Mine', query: { assignee: 'me' } });
  return { ada, bo, token, cli, orgId, slug, juniper, tasks };
}

/** What the web shows: core `selectSavedView` over the server's rows, flattened. */
async function webRows(user: TestUser, orgId: string, view: ViewJson, completed = false) {
  const me = (await user.api<MeJson>('GET', '/api/v1/me')).data;
  const { data } = await user.api<{ items: Task[]; counts: { open: number; done: number } }>(
    'GET',
    `/api/v1/views/${view.id}/tasks${completed ? '?completed=true' : ''}`,
  );
  const members = (
    await user.api<{ userId: string; name: string }[]>('GET', `/api/v1/orgs/${orgId}/members`)
  ).data;
  const sections = selectSavedView(data.items, view.query, {
    viewerId: me.id,
    due: { today: todayIn(me.timezone, Date.now()), nowMs: Date.now(), viewerTz: me.timezone },
    members: members.map((m) => ({ userId: m.userId, name: m.name })),
    locale: me.locale,
    isPersonal: false,
    showCompleted: completed,
  });
  return { ids: sections.flatMap((s) => s.taskIds), counts: data.counts };
}

/** The org's tasks with these titles, once they all exist. */
async function eventuallyTasks(user: TestUser, orgId: string, titles: string[]) {
  const started = Date.now();
  for (;;) {
    const { data } = await user.api<{ items: TaskJson[] }>(
      'GET',
      `/api/v1/orgs/${orgId}/tasks?view=everyone&limit=200`,
    );
    const found = titles.map((title) => data.items.find((task) => task.title === title));
    if (found.every((task) => task !== undefined)) return found as TaskJson[];
    if (Date.now() - started > 3_000) throw new Error(`missing: ${titles.join(', ')}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function json<T>(cli: CliHarness, args: string[]): Promise<T> {
  const res = await cli.run([...args, '--json']);
  expect(res.code, res.stderr).toBe(0);
  return JSON.parse(res.stdout) as T;
}

describe('views from the command line (ADR 0073 B12)', () => {
  it('AC-13.5 rooster ls --view Juniper lists the web view’s rows in its order', async () => {
    const { ada, cli, orgId, slug, juniper, tasks } = await seed();
    const web = await webRows(ada, orgId, juniper);
    const listed = await json<TaskJson[]>(cli, ['ls', '--view', 'Juniper', '--org', slug]);
    expect(listed.map((t) => t.id)).toEqual(web.ids);
    expect(listed.map((t) => t.title)).toEqual([
      'Ada today',
      'Ada undated',
      'Bo soon',
      'Cy later',
      'Juniper subtask',
      'Nobody’s',
    ]);
    // --completed, as the header's "Show completed".
    const all = await json<TaskJson[]>(cli, [
      'ls',
      '--view',
      'juniper',
      '--org',
      slug,
      '--completed',
    ]);
    expect(all.map((t) => t.id)).toEqual((await webRows(ada, orgId, juniper, true)).ids);
    expect(all.map((t) => t.id)).toContain(tasks.done?.id);
    // By ID too.
    const byId = await json<TaskJson[]>(cli, ['ls', '--view', juniper.id, '--org', slug]);
    expect(byId.map((t) => t.id)).toEqual(web.ids);
  });

  it('prints the person sections and the project header; view ls lists my views', async () => {
    const { cli, slug } = await seed();
    const res = await cli.run(['ls', '--view', 'Juniper', '--org', slug]);
    expect(res.code, res.stderr).toBe(0);
    const lines = stripAnsi(res.stdout).trimEnd().split('\n');
    expect(lines[0]).toBe('Kestrel · Juniper  6 open · 1 done');
    expect(lines.filter((l) => /^\S.* \(\d+\)$/.test(l))).toEqual([
      'Ada (you) (2)',
      'Bo (1)',
      'Cy (2)',
      'Unassigned (1)',
    ]);
    // Its parent isn't in the view; the server sends it for the breadcrumb only.
    expect(lines.find((l) => l.includes('Juniper subtask'))).toMatch(
      /Not Juniper › Juniper subtask/,
    );
    expect(lines.filter((l) => l.includes('Not Juniper'))).toHaveLength(1);
    expect(res.stdout).not.toContain('@example.com');

    const views = stripAnsi((await cli.run(['view', 'ls', '--org', slug])).stdout)
      .trimEnd()
      .split('\n');
    expect(views[0]).toBe('Kestrel · Views');
    expect(views.slice(1)).toEqual([
      expect.stringMatching(/^# {2}Juniper {2}shared {3}6 open$/),
      expect.stringMatching(/^⌕ {2}Mine {5}private {2}\d+ open$/),
    ]);
    const unknown = await cli.run(['ls', '--view', 'Nope', '--org', slug]);
    expect(unknown.code).toBe(4);
    expect(unknown.stderr).toContain('Juniper, Mine');
  });

  it('another member sees the shared view but not my private one', async () => {
    const { bo, slug, orgId, juniper } = await seed();
    const { token } = await bo.token({ scopes: ['tasks:read'] as never });
    const cli = cliHarness();
    try {
      expect(
        (await cli.run(['login', '--with-token', '--server', server.url], { stdin: token })).code,
      ).toBe(0);
      const views = await json<ViewJson[]>(cli, ['view', 'ls', '--org', slug]);
      expect(views.map((v) => v.name)).toEqual(['Juniper']);
      const listed = await json<TaskJson[]>(cli, ['ls', '--view', 'Juniper', '--org', slug]);
      expect(listed.map((t) => t.id)).toEqual((await webRows(bo, orgId, juniper)).ids);
      // Bo's own section comes first for Bo.
      expect(listed[0]?.title).toBe('Bo soon');
      expect((await cli.run(['ls', '--view', 'Mine', '--org', slug])).code).toBe(4);
    } finally {
      cli.cleanup();
    }
  });

  it('AC-13.5 MCP list_views and list_tasks {view: "Juniper"} return the same rows', async () => {
    const { ada, token, orgId, slug, juniper } = await seed();
    const mcpServer = createRoosterMcpServer({
      client: createRoosterClient({ baseUrl: server.url, token }),
      listing: { mode: 'granted', scopes: ['tasks:read'] },
      defaultOrg: slug,
      instanceUrl: server.url,
      version: '1.11.0',
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(b);
    const mcp = new Client({ name: 'views', version: '1.0.0' });
    await mcp.connect(a);
    try {
      const views = (await mcp.callTool({ name: 'list_views', arguments: {} })) as {
        structuredContent: { views: { id: string; name: string; project?: boolean }[] };
      };
      expect(views.structuredContent.views).toEqual([
        expect.objectContaining({ id: juniper.id, name: 'Juniper', project: true, shared: true }),
        expect.objectContaining({ name: 'Mine', shared: false }),
      ]);
      const result = (await mcp.callTool({
        name: 'list_tasks',
        arguments: { view: 'Juniper' },
      })) as { structuredContent: { tasks: { ref: string }[] } };
      const web = await webRows(ada, orgId, juniper);
      const all = (await ada.api<{ items: TaskJson[] }>('GET', `/api/v1/views/${juniper.id}/tasks`))
        .data.items;
      const byId = new Map(all.map((t) => [t.id, t]));
      expect(result.structuredContent.tasks.map((t) => t.ref)).toEqual(
        web.ids.map((id) => `${slug}#${byId.get(id)?.seq}`),
      );
    } finally {
      await mcp.close();
      await mcpServer.close();
    }
  });

  it('the TUI lists the views after the built-in tabs; g 1 opens one, n adds with its tags', async () => {
    const { ada, cli, slug, orgId, juniper } = await seed();
    // The TUI opens on the profile's org.
    expect((await cli.run(['org', 'use', slug])).code).toBe(0);
    const t = await openTui(cli, { columns: 140, rows: 40 });
    tuis.push(t);
    let frame = await t.waitFor((f) => f.includes('# Juniper 6'));
    expect(frame.split('\n')[1]).toMatch(/Everyone’s tasks │ # Juniper 6 │ ⌕ Mine/);
    await t.press('g', '1');
    frame = await t.waitFor((f) => f.includes('Ada (you) (2)') && f.includes('Bo soon'));
    const order = ['Ada today', 'Ada undated', 'Bo (1)', 'Bo soon', 'Cy (2)', 'Cy later'];
    const at = order.map((text) => frame.indexOf(text));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    expect(frame).toContain('Unassigned (1)');
    expect(frame).not.toContain('Done Juniper');
    // A task typed in the view gets its tag and lands in my section.
    await t.press('n');
    await t.type('Book the venue');
    await t.press('\r', '\u001b');
    frame = await t.waitFor((f) => f.includes('Book the venue') && f.includes('Ada (you) (3)'));
    const created = (
      await ada.api<{ items: TaskJson[] }>('GET', `/api/v1/views/${juniper.id}/tasks`)
    ).data.items.find((task) => task.title === 'Book the venue');
    expect(created?.tagIds).toEqual(juniper.query.tags);
    expect(created?.assigneeId).toBe(ada.userId);
    // Live: a change made elsewhere (the web) shows up.
    await ada.api('POST', `/api/v1/orgs/${orgId}/tasks`, {
      title: 'From the web',
      tagIds: juniper.query.tags,
      assigneeId: null,
    });
    await t.waitFor((f) => f.includes('From the web') && f.includes('Unassigned (2)'));
    // Renamed and then archived elsewhere: the tab follows, and the view closes.
    await ada.api('PATCH', `/api/v1/views/${juniper.id}`, { name: 'Juniper launch' });
    await t.waitFor((f) => f.includes('# Juniper launch'));
    await ada.api('POST', `/api/v1/views/${juniper.id}/archive`);
    frame = await t.waitFor((f) => f.includes('no longer available'));
    expect(frame).not.toContain('# Juniper');
    // g then a digit with no such view says so.
    await t.press('g', '5');
    await t.waitFor((f) => f.includes('No view 5'));
  });

  it('TUI: rapid entry under another person keeps that person when the rows leave the view', async () => {
    const { ada, cli, slug, orgId, tasks } = await seed();
    const tagId = tasks.adaToday?.tagIds[0] as string;
    const due = await ada.api<ViewJson>('POST', `/api/v1/orgs/${orgId}/views`, {
      name: 'Juniper today',
      shared: true,
      query: { tags: [tagId], due: 'today' },
    });
    expect(due.status).toBe(201);
    expect((await cli.run(['org', 'use', slug])).code).toBe(0);
    const t = await openTui(cli, { columns: 140, rows: 40 });
    tuis.push(t);
    await t.waitFor((f) => f.includes('# Juniper today'));
    await t.press('g', '3');
    await t.waitFor((f) => f.includes('Unassigned (0)') && f.includes('Ada today'));
    // The last line is Unassigned's header; undated tasks typed there don't match the view.
    await t.press('\u001b[F');
    await t.waitFor((f) =>
      f.split('\n').some((l) => l.includes('› ▾ Unassigned') || /› .*Unassigned/.test(l)),
    );
    await t.press('n');
    await t.type('First loose end');
    await t.press('\r');
    await t.type('Second loose end');
    await t.press('\r', '\u001b');
    const created = await eventuallyTasks(ada, orgId, ['First loose end', 'Second loose end']);
    for (const task of created) {
      expect(task.assigneeId, task.title).toBeNull();
      expect(task.tagIds, task.title).toEqual([tagId]);
    }
  });

  it('TUI: a row completed in a view stays in place for completeHideMs', async () => {
    const { ada, cli, slug } = await seed();
    // 0 keeps completed rows for the session (D-09), so the check can't race a timer.
    const prefs = await ada.api('PATCH', '/api/v1/me', { prefs: { completeHideMs: 0 } });
    expect(prefs.status).toBe(200);
    expect((await cli.run(['org', 'use', slug])).code).toBe(0);
    const t = await openTui(cli, { columns: 140, rows: 40 });
    tuis.push(t);
    await t.waitFor((f) => f.includes('# Juniper'));
    await t.press('g', '1');
    await t.waitFor((f) => f.includes('Ada (you) (2)'));
    // The first row is Ada's task due today.
    await t.waitFor((f) => f.split('\n').some((l) => l.includes('› ') && l.includes('Ada today')));
    await t.press('x');
    await t.waitFor((f) => f.includes('Completed “Ada today”') && f.includes('● synced'));
    // The refresh after the change (without completed tasks) has landed; the row is still there.
    await new Promise((resolve) => setTimeout(resolve, 300));
    // (The footer's "Completed “Ada today”" doesn't count: the row itself is still listed.)
    const rows = t
      .frame()
      .split('\n')
      .filter((l) => l.includes('Ada today'));
    expect(rows.filter((l) => !l.includes('Completed'))).toHaveLength(1);
    expect(t.frame()).toContain('Ada (you) (1)');
  });

  it('TUI: a held row deleted elsewhere goes; a held subtask keeps its breadcrumb', async () => {
    const { ada, cli, slug, tasks } = await seed();
    expect((await ada.api('PATCH', '/api/v1/me', { prefs: { completeHideMs: 0 } })).status).toBe(
      200,
    );
    expect((await cli.run(['org', 'use', slug])).code).toBe(0);
    const t = await openTui(cli, { columns: 140, rows: 40 });
    tuis.push(t);
    await t.waitFor((f) => f.includes('# Juniper'));
    await t.press('g', '1');
    await t.waitFor((f) => f.includes('Ada (you) (2)'));
    const rowOf = (f: string, title: string) =>
      f.split('\n').filter((l) => l.includes(title) && !l.includes('Completed'));
    const selected = (f: string) => f.split('\n').find((l) => l.includes('│ › ')) ?? '';
    const selectRow = async (title: string) => {
      await t.press('\u001b[H');
      for (let i = 0; i < 20 && !selected(t.frame()).includes(title); i++) await t.press('j');
      expect(selected(t.frame())).toContain(title);
    };
    // The subtask: its parent "Not Juniper" isn't in the view, only its breadcrumb.
    await selectRow('Juniper subtask');
    expect(selected(t.frame())).toContain('Not Juniper › Juniper subtask');
    await t.press('x');
    await t.waitFor((f) => f.includes('Completed “Juniper subtask”') && f.includes('● synced'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(rowOf(t.frame(), 'Juniper subtask')).toEqual([
      expect.stringContaining('Not Juniper › Juniper subtask'),
    ]);
    // A held row deleted on the web leaves with the refresh (SSE) instead of staying selectable.
    await selectRow('Ada today');
    await t.press('x');
    await t.waitFor((f) => f.includes('Completed “Ada today”') && f.includes('● synced'));
    expect((await ada.api('DELETE', `/api/v1/tasks/${tasks.adaToday?.id}`)).status).toBe(204);
    await t.waitFor((f) => rowOf(f, 'Ada today').length === 0);
    // The other held row stays.
    expect(rowOf(t.frame(), 'Juniper subtask')).toHaveLength(1);
  });
});
