// Phase 6 (WP 6.1–6.6, server side): assignment, Everyone's tasks, activity, comments,
// followers, notifications, member removal, and the search/export/retention side of comments.

import { formatMention } from '@rooster/core/mentions';
import type {
  Activity,
  ActivityPage,
  BulkResult,
  Comment,
  FollowState,
  NotificationPage,
  NotificationPrefs,
  OrgExport,
  Problem,
  SearchHit,
  SseNotification,
  TaskDetail,
  TaskPage,
  TaskPatchResult,
} from '@rooster/core/schemas';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { activity, follower, notification, taskGroup } from '../src/db/schema/index.ts';
import {
  type Caller,
  createTask,
  groupNamed,
  inboxOf,
  listCtx,
  myList,
  sharedOrg,
  titlesIn,
} from './list-helpers.ts';
import { SseClient, until } from './sse-client.ts';

const DAY = 86_400_000;
const COALESCE_MS = 15;
const settle = () => new Promise((resolve) => setTimeout(resolve, COALESCE_MS * 4));

const open: SseClient[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
});

async function listen(c: Caller): Promise<SseClient> {
  const res = await c.call('GET', '/api/v1/events');
  expect(res.status).toBe(200);
  const client = new SseClient(res);
  open.push(client);
  await until(() => client.hello !== undefined, 1_000, 'hello');
  return client;
}

const notificationsOf = (c: SseClient) =>
  c.frames.filter((f) => f.event === 'notification').map((f) => f.data as SseNotification);

/** Ann owns a shared org with member Bo; Cy is an outsider. A clock that ticks per call. */
async function team(options: { clock?: () => number } = {}) {
  let now = Date.UTC(2026, 9, 1, 8);
  const ctx = listCtx({
    sse: { coalesceMs: COALESCE_MS },
    clock: options.clock ?? (() => (now += 1)),
  });
  const a = ctx.user('ann@example.com', 'Ann Andersson');
  const b = ctx.user('bo@example.com', 'Bo Berg');
  const c = ctx.user('cy@example.com', 'Cy Carlsson');
  const org = await sharedOrg(a, [b]);
  // Start every test with an empty inbox (Ann was told that Bo joined).
  ctx.db.orm.delete(notification).run();
  return { ...ctx, a, b, c, org };
}

const patch = (c: Caller, id: string, body: unknown, headers?: Record<string, string>) =>
  c.ok<TaskPatchResult>('PATCH', `/api/v1/tasks/${id}`, body, 200, headers);

const notifications = (c: Caller, query = '') =>
  c.ok<NotificationPage>('GET', `/api/v1/notifications${query}`);

const feed = (c: Caller, taskId: string, query = '') =>
  c.ok<ActivityPage>('GET', `/api/v1/tasks/${taskId}/activity${query}`);

const activities = async (c: Caller, taskId: string): Promise<Activity[]> =>
  (await feed(c, taskId, '?limit=200')).items.flatMap((i) =>
    i.kind === 'activity' ? [i.activity] : [],
  );

const everyone = (c: Caller, orgId: string, query = '') =>
  c.ok<TaskPage>('GET', `/api/v1/orgs/${orgId}/tasks?view=everyone${query}`);

const comment = (c: Caller, taskId: string, body: string, id?: string) =>
  c.ok<Comment>(
    'POST',
    `/api/v1/tasks/${taskId}/comments`,
    { body, ...(id === undefined ? {} : { id }) },
    201,
  );

describe('assignment (WP 6.1, FR-COL-1/2)', () => {
  it('AC-6.1 A assigns a task to B: top of B’s Inbox, gone from A’s groups, B notified, A not', async () => {
    const { a, b, org } = await team();
    const prio = await groupNamed(a, 'Prio', org.id);
    const task = await createTask(a, { title: 'Review', groupId: prio.id }, org.id);
    await createTask(b, { title: 'B’s own' }, org.id);
    const [sa, sb] = [await listen(a), await listen(b)];

    const { task: moved } = await patch(a, task.id, { assigneeId: b.userId });
    expect(moved.assigneeId).toBe(b.userId);
    expect(moved.placement).toBeNull();

    const bInbox = await inboxOf(b, org.id);
    expect(await titlesIn(b, bInbox.id, org.id)).toEqual(['Review', 'B’s own']);
    expect((await myList(a, org.id)).tasks.map((t) => t.id)).not.toContain(task.id);

    const forB = await notifications(b);
    expect(forB.unreadCount).toBe(1);
    expect(forB.items).toHaveLength(1);
    expect(forB.items[0]).toMatchObject({
      type: 'assigned',
      orgId: org.id,
      orgSlug: org.slug,
      task: { id: task.id, title: 'Review', seq: task.seq },
      actor: { id: a.userId, name: 'Ann Andersson' },
      readAt: null,
    });
    expect((await notifications(a)).items).toEqual([]);

    // Live: B's stream hears its list changed and gets the notification event; A's list too.
    await until(() => sb.keys.includes(`my-list/${org.id}`), 1_000, 'B my-list');
    await until(() => notificationsOf(sb).length > 0, 1_000, 'B notification');
    expect(notificationsOf(sb)[0]).toEqual({
      unreadCount: 1,
      notification: {
        id: forB.items[0]?.id,
        orgId: org.id,
        type: 'assigned',
        taskId: task.id,
        actorName: 'Ann Andersson',
        title: 'Review',
      },
    });
    expect(sb.keys).toContain('notifications');
    await until(() => sa.keys.includes(`my-list/${org.id}`), 1_000, 'A my-list');
    await settle();
    expect(notificationsOf(sa)).toEqual([]);
    expect(sa.keys).not.toContain('notifications');
  });

  it('creates for another member at the top of their Inbox, ignoring my group; null is unassigned', async () => {
    const { a, b, org } = await team();
    const prio = await groupNamed(a, 'Prio', org.id);
    await createTask(b, { title: 'Older' }, org.id);
    const forB = await createTask(
      a,
      { title: 'For Bo', assigneeId: b.userId, groupId: prio.id, afterId: null },
      org.id,
    );
    expect(forB.assigneeId).toBe(b.userId);
    expect(forB.placement).toBeNull();
    expect(await titlesIn(b, (await inboxOf(b, org.id)).id, org.id)).toEqual(['For Bo', 'Older']);
    expect(await titlesIn(a, prio.id, org.id)).toEqual([]);
    expect((await notifications(b)).items.map((n) => n.type)).toEqual(['assigned']);

    const loose = await createTask(a, { title: 'Nobody', assigneeId: null }, org.id);
    expect(loose).toMatchObject({ assigneeId: null, placement: null });
    expect((await myList(a, org.id)).tasks.map((t) => t.id)).not.toContain(loose.id);
    const mine = await createTask(
      a,
      { title: 'Mine', assigneeId: a.userId, groupId: prio.id },
      org.id,
    );
    expect(mine.placement?.groupId).toBe(prio.id);
  });

  it('rejects assignees outside the org, and anyone but me in a personal org (422 on assigneeId)', async () => {
    const { a, b, c, org } = await team();
    const task = await createTask(a, { title: 'T' }, org.id);
    for (const [path, method, body] of [
      [`/api/v1/tasks/${task.id}`, 'PATCH', { assigneeId: c.userId }],
      [`/api/v1/orgs/${org.id}/tasks`, 'POST', { title: 'x', assigneeId: c.userId }],
      ['/api/v1/orgs/personal/tasks', 'POST', { title: 'x', assigneeId: b.userId }],
      ['/api/v1/orgs/personal/tasks', 'POST', { title: 'x', assigneeId: null }],
    ] as const) {
      const res = await a.call(method, path, body);
      expect(res.status, path).toBe(422);
      const problem = (await res.json()) as Problem;
      expect(problem.code).toBe('validation_failed');
      expect(problem.errors?.map((e) => e.path)).toEqual(['assigneeId']);
    }
    const own = await createTask(a, { title: 'Personal' });
    expect((await a.call('PATCH', `/api/v1/tasks/${own.id}`, { assigneeId: null })).status).toBe(
      422,
    );
    expect((await patch(a, own.id, { assigneeId: a.userId })).ignoredFields).toEqual([]);
  });

  it('assignee is last-write-wins on its own clock', async () => {
    const { a, b, org } = await team({ clock: () => Date.UTC(2026, 9, 1) });
    const task = await createTask(a, { title: 'T' }, org.id);
    const t0 = Date.UTC(2026, 9, 1);
    const later = await patch(
      a,
      task.id,
      { assigneeId: b.userId },
      { 'X-Rooster-Edit-Time': String(t0 - 1_000) },
    );
    expect(later.task.assigneeId).toBe(b.userId);
    const stale = await patch(
      a,
      task.id,
      { assigneeId: null, title: 'Renamed' },
      { 'X-Rooster-Edit-Time': String(t0 - 2_000) },
    );
    expect(stale.ignoredFields).toEqual(['assigneeId']);
    expect(stale.task).toMatchObject({ assigneeId: b.userId, title: 'Renamed' });
  });

  it('bulk assign is atomic per task', async () => {
    const { a, b, c, org } = await team();
    const one = await createTask(a, { title: 'One' }, org.id);
    const two = await createTask(a, { title: 'Two' }, org.id);
    const theirs = await createTask(c, { title: 'Cy’s' });
    const result = await a.ok<BulkResult>('POST', '/api/v1/tasks/bulk', {
      op: 'assign',
      ids: [one.id, two.id, theirs.id],
      args: { assigneeId: b.userId },
    });
    expect(result.results).toEqual([
      { id: one.id, ok: true },
      { id: two.id, ok: true },
      { id: theirs.id, ok: false, code: 'not_found' },
    ]);
    expect(
      await titlesIn(b, (await inboxOf(b, org.id)).id, org.id).then((t) => [...t].sort()),
    ).toEqual(['One', 'Two']);
    const bad = await a.ok<BulkResult>('POST', '/api/v1/tasks/bulk', {
      op: 'assign',
      ids: [one.id],
      args: { assigneeId: c.userId },
    });
    expect(bad.results).toEqual([{ id: one.id, ok: false, code: 'validation_failed' }]);
  });

  it('AC-6.2 an orphan subtask is B’s own row; assigning the parent to B folds it back', async () => {
    const { a, b, org } = await team();
    const parent = await createTask(a, { title: 'Parent' }, org.id);
    const sub = await createTask(a, { title: 'Sub', parentId: parent.id }, org.id);
    expect(sub.assigneeId).toBe(a.userId);
    await patch(a, sub.id, { assigneeId: b.userId });
    // B inherits a new subtask of B's own subtask quietly: it stays inside B's row.
    const inner = await createTask(a, { title: 'Inner', parentId: sub.id }, org.id);
    expect(inner.assigneeId).toBe(b.userId);
    expect((await notifications(b)).items.map((n) => n.task?.title)).toEqual(['Sub']);

    let list = await myList(b, org.id);
    const row = list.tasks.find((t) => t.id === sub.id);
    expect(row?.placement?.groupId).toBe((await inboxOf(b, org.id)).id);
    // The parent comes along without a placement, for the "Parent ›" breadcrumb.
    expect(list.tasks.find((t) => t.id === parent.id)?.placement).toBeNull();
    expect((await everyone(a, org.id)).items.map((t) => t.title).sort()).toEqual(['Parent', 'Sub']);

    await patch(a, parent.id, { assigneeId: b.userId });
    list = await myList(b, org.id);
    expect(list.tasks.find((t) => t.id === sub.id)?.placement).toBeNull();
    expect(list.tasks.find((t) => t.id === parent.id)?.placement).not.toBeNull();
    expect((await myList(a, org.id)).tasks.map((t) => t.id)).not.toContain(parent.id);
    expect((await everyone(a, org.id)).items.map((t) => t.title)).toEqual(['Parent']);
  });

  it('parse: true assigns an unambiguous @member and leaves an ambiguous token in the title', async () => {
    const { a, b, ctx, org } = await (async () => {
      const t = await team();
      return { ...t, ctx: t };
    })();
    const bea = ctx.user('bea@example.com', 'Bea Björk');
    const { url } = await a.ok<{ url: string }>(
      'POST',
      `/api/v1/orgs/${org.id}/invites`,
      { role: 'member' },
      201,
    );
    await bea.ok('POST', `/api/v1/invites/${url.split('/invite/')[1]}/accept`);

    const byName = await createTask(a, { title: 'Call @bo tomorrow', parse: true }, org.id);
    expect(byName).toMatchObject({ title: 'Call', assigneeId: b.userId });
    expect(byName.dueDate).not.toBeNull();
    const byEmail = await createTask(a, { title: 'Ping @BEA', parse: true }, org.id);
    expect(byEmail).toMatchObject({ title: 'Ping', assigneeId: bea.userId });
    const ambiguous = await createTask(a, { title: 'Ask @b', parse: true }, org.id);
    expect(ambiguous).toMatchObject({ title: 'Ask @b', assigneeId: a.userId });
    // Only a trailing token counts (the position rule of `>Group`).
    const inside = await createTask(a, { title: 'Ask @bo about it', parse: true }, org.id);
    expect(inside).toMatchObject({ title: 'Ask @bo about it', assigneeId: a.userId });
    const me = await createTask(a, { title: 'Mine @me', parse: true }, org.id);
    expect(me).toMatchObject({ title: 'Mine', assigneeId: a.userId });
    const explicit = await createTask(
      a,
      { title: 'Keep @bo', parse: true, assigneeId: a.userId },
      org.id,
    );
    expect(explicit).toMatchObject({ title: 'Keep @bo', assigneeId: a.userId });
  });
});

describe('Everyone’s tasks (WP 6.2, FR-VIEW-2)', () => {
  it('lists every assignee’s rows by due date (none last), then created; filters combine', async () => {
    const { a, b, org } = await team();
    const late = await createTask(a, { title: 'late', dueDate: '2026-10-20' }, org.id);
    await createTask(
      a,
      { title: 'late timed', dueDate: '2026-10-20', dueTime: '10:00', dueTz: 'UTC' },
      org.id,
    );
    const none1 = await createTask(a, { title: 'none 1' }, org.id);
    const early = await createTask(b, { title: 'early', dueDate: '2026-10-05' }, org.id);
    const loose = await createTask(a, { title: 'loose', assigneeId: null }, org.id);
    const done = await createTask(b, { title: 'done', dueDate: '2026-10-01' }, org.id);
    await b.ok('POST', `/api/v1/tasks/${done.id}/complete`, { completed: true });
    // An unassigned subtask of an unassigned parent shows only under the parent.
    await createTask(a, { title: 'loose sub', parentId: loose.id }, org.id);
    const tag = await a.ok<{ id: string }>(
      'POST',
      `/api/v1/orgs/${org.id}/tags`,
      { name: 'Red' },
      201,
    );
    await a.ok('PUT', `/api/v1/tasks/${late.id}/tags/${tag.id}`);

    const titles = async (query = '') =>
      (await everyone(b, org.id, query)).items.map((t) => t.title);
    expect(await titles()).toEqual(['early', 'late timed', 'late', 'none 1', 'loose']);
    expect(await titles('&completed=any')).toEqual([
      'done',
      'early',
      'late timed',
      'late',
      'none 1',
      'loose',
    ]);
    expect(await titles('&assignee=me')).toEqual(['early']);
    expect(await titles(`&assignee=${a.userId}`)).toEqual(['late timed', 'late', 'none 1']);
    expect(await titles('&assignee=none')).toEqual(['loose']);
    expect(await titles(`&assignee=none&assignee=${a.userId}`)).toEqual([
      'late timed',
      'late',
      'none 1',
      'loose',
    ]);
    expect(await titles('&assignee=any')).toEqual([
      'early',
      'late timed',
      'late',
      'none 1',
      'loose',
    ]);
    expect(await titles('&hasDue=true')).toEqual(['early', 'late timed', 'late']);
    expect(await titles('&hasDue=false')).toEqual(['none 1', 'loose']);
    expect(await titles('&tag=red')).toEqual(['late']);
    expect(await titles('&dueFrom=2026-10-10')).toEqual(['late timed', 'late']);

    // The placement is the requester's own.
    const items = (await everyone(b, org.id)).items;
    expect(items.find((t) => t.id === early.id)?.placement).not.toBeNull();
    expect(items.find((t) => t.id === late.id)?.placement).toBeNull();
    expect(items.find((t) => t.id === none1.id)?.assigneeId).toBe(a.userId);

    const first = await everyone(b, org.id, '&limit=3');
    expect(first.items.map((t) => t.title)).toEqual(['early', 'late timed', 'late']);
    const second = await everyone(b, org.id, `&limit=3&cursor=${first.nextCursor}`);
    expect(second.items.map((t) => t.title)).toEqual(['none 1', 'loose']);
    expect(second.nextCursor).toBeNull();
  });

  it('is 409 personal_org in a personal org and 422 with a groupId', async () => {
    const { a, org } = await team();
    const res = await a.call('GET', '/api/v1/orgs/personal/tasks?view=everyone');
    expect(res.status).toBe(409);
    expect(((await res.json()) as Problem).code).toBe('personal_org');
    const inbox = await inboxOf(a, org.id);
    const bad = await a.call(
      'GET',
      `/api/v1/orgs/${org.id}/tasks?view=everyone&groupId=${inbox.id}`,
    );
    expect(bad.status).toBe(422);
  });
});

describe('activity (WP 6.3, FR-COL-5)', () => {
  it('records each kind of change once, with via from X-Rooster-Client; no-ops write nothing', async () => {
    const { a, b, org } = await team();
    const cli = { 'X-Rooster-Client': 'cli/1.2.0' };
    const parent = await createTask(a, { title: 'Parent' }, org.id);
    const other = await createTask(a, { title: 'Other' }, org.id);
    const t = await createTask(a, { title: 'Task' }, org.id);
    await patch(a, t.id, { title: 'Task 2' }, cli);
    await patch(a, t.id, { title: 'Task 2' });
    await patch(a, t.id, { description: 'Body' });
    await patch(a, t.id, { dueDate: '2026-10-10', dueTime: '09:00', dueTz: 'Europe/Stockholm' });
    await patch(a, t.id, { assigneeId: b.userId }, { 'X-Rooster-Client': 'weird' });
    await b.ok('POST', `/api/v1/tasks/${t.id}/complete`, { completed: true });
    await b.ok('POST', `/api/v1/tasks/${t.id}/complete`, { completed: true });
    await b.ok('POST', `/api/v1/tasks/${t.id}/complete`, { completed: false });
    await patch(a, t.id, { parentId: parent.id });
    await patch(a, t.id, { parentId: other.id });
    await a.ok('DELETE', `/api/v1/tasks/${t.id}`, undefined, 204);
    await a.ok('POST', `/api/v1/tasks/${t.id}/restore`);

    const entries = await activities(a, t.id);
    expect(entries.map((e) => [e.type, e.data, e.actorId === a.userId ? 'A' : 'B', e.via])).toEqual(
      [
        ['created', {}, 'A', 'web'],
        ['renamed', { from: 'Task', to: 'Task 2' }, 'A', 'cli'],
        ['description_edited', {}, 'A', 'web'],
        [
          'due_changed',
          { from: null, to: { dueDate: '2026-10-10', dueTime: '09:00' } },
          'A',
          'web',
        ],
        ['assigned', { from: a.userId, to: b.userId }, 'A', 'web'],
        ['completed', {}, 'B', 'web'],
        ['reopened', {}, 'B', 'web'],
        ['moved_parent', { from: null, to: parent.id }, 'A', 'web'],
        ['moved_parent', { from: parent.id, to: other.id }, 'A', 'web'],
        ['restored', {}, 'A', 'web'],
      ],
    );
    expect((await activities(a, parent.id)).map((e) => [e.type, e.data])).toEqual([
      ['created', {}],
      ['subtask_added', { subtaskId: t.id, title: 'Task 2' }],
    ]);
    const sub = await createTask(a, { title: 'Child', parentId: other.id }, org.id);
    expect((await activities(a, other.id)).map((e) => e.type)).toEqual([
      'created',
      'subtask_added',
      'subtask_added',
    ]);
    expect((await activities(a, other.id)).at(-1)?.data).toEqual({
      subtaskId: sub.id,
      title: 'Child',
    });
  });

  it('is written in personal orgs too', async () => {
    const { a } = await team();
    const t = await createTask(a, { title: 'Mine' });
    await patch(a, t.id, { title: 'Renamed' });
    expect((await activities(a, t.id)).map((e) => e.type)).toEqual(['created', 'renamed']);
  });

  it('pages back in time: oldest first within a page, nextCursor continues older', async () => {
    const { a, org } = await team();
    const t = await createTask(a, { title: 'v0' }, org.id);
    await comment(a, t.id, 'first');
    await patch(a, t.id, { title: 'v1' });
    await comment(a, t.id, 'second');
    await patch(a, t.id, { title: 'v2' });

    const label = (p: ActivityPage) =>
      p.items.map((i) => (i.kind === 'comment' ? i.comment.body : i.activity.type));
    const newest = await feed(a, t.id, '?limit=2');
    expect(label(newest)).toEqual(['second', 'renamed']);
    const middle = await feed(a, t.id, `?limit=2&cursor=${newest.nextCursor}`);
    expect(label(middle)).toEqual(['first', 'renamed']);
    const oldest = await feed(a, t.id, `?limit=2&cursor=${middle.nextCursor}`);
    expect(label(oldest)).toEqual(['created']);
    expect(oldest.nextCursor).toBeNull();
    expect(label(await feed(a, t.id, '?filter=comments'))).toEqual(['first', 'second']);
    expect((await a.call('GET', `/api/v1/tasks/${t.id}/activity?cursor=nope`)).status).toBe(422);
  });
});

describe('comments (WP 6.3, FR-COL-3)', () => {
  it('creates idempotently by id, edits with editedAt, deletes softly and restores; author only', async () => {
    const { a, b, c, org } = await team();
    const t = await createTask(a, { title: 'T' }, org.id);
    const id = '0199aaaa-0000-7000-8000-00000000c001';
    const first = await comment(a, t.id, 'Hello', id);
    expect(first).toMatchObject({
      id,
      taskId: t.id,
      authorId: a.userId,
      body: 'Hello',
      editedAt: null,
    });
    expect(await comment(a, t.id, 'Hello', id)).toEqual(first);
    expect(
      (await a.call('POST', `/api/v1/tasks/${t.id}/comments`, { id, body: 'Other' })).status,
    ).toBe(409);

    const counts = async () =>
      (await myList(a, org.id)).tasks.find((x) => x.id === t.id)?.counts.comments;
    expect(await counts()).toBe(1);

    const forbidden = await b.call('PATCH', `/api/v1/comments/${id}`, { body: 'Hijack' });
    expect(forbidden.status).toBe(403);
    expect(((await forbidden.json()) as Problem).code).toBe('forbidden');
    expect((await c.call('PATCH', `/api/v1/comments/${id}`, { body: 'x' })).status).toBe(404);
    expect((await b.call('DELETE', `/api/v1/comments/${id}`)).status).toBe(403);
    expect((await a.call('PATCH', `/api/v1/comments/${id}`, { body: '  ' })).status).toBe(422);

    const edited = await a.ok<Comment>('PATCH', `/api/v1/comments/${id}`, { body: 'Hello!' });
    expect(edited.body).toBe('Hello!');
    expect(edited.editedAt).toEqual(expect.any(Number));

    await a.ok('DELETE', `/api/v1/comments/${id}`, undefined, 204);
    await a.ok('DELETE', `/api/v1/comments/${id}`, undefined, 204);
    expect(await counts()).toBe(0);
    expect((await feed(a, t.id, '?filter=comments')).items).toEqual([]);
    expect((await a.call('PATCH', `/api/v1/comments/${id}`, { body: 'x' })).status).toBe(410);
    expect((await b.call('POST', `/api/v1/comments/${id}/restore`)).status).toBe(403);
    const restored = await a.ok<Comment>('POST', `/api/v1/comments/${id}/restore`);
    expect(restored.body).toBe('Hello!');
    expect(await counts()).toBe(1);

    await a.ok('DELETE', `/api/v1/tasks/${t.id}`, undefined, 204);
    expect((await a.call('POST', `/api/v1/tasks/${t.id}/comments`, { body: 'Late' })).status).toBe(
      410,
    );
    // The feed of a task in Trash stays readable.
    expect((await feed(a, t.id, '?filter=comments')).items).toHaveLength(1);
  });

  it('AC-6.3 mentioning @B notifies B and makes B a follower; other followers get `comment`', async () => {
    const { a, b, c, org } = await team();
    const t = await createTask(a, { title: 'Plan' }, org.id);
    const sb = await listen(b);
    const body = `Can ${formatMention('Bo', b.userId)} and ${formatMention('Cy', c.userId)} look?`;
    const created = await comment(a, t.id, body);

    const forB = await notifications(b);
    expect(forB.items.map((n) => [n.type, n.data])).toEqual([
      ['mention', { commentId: created.id, excerpt: 'Can @Bo and @Cy look?' }],
    ]);
    await until(() => notificationsOf(sb).some((n) => n.notification?.type === 'mention'));
    // The non-member is ignored: no notification, not a follower.
    expect((await notifications(c)).items).toEqual([]);
    const detail = await a.ok<TaskDetail>('GET', `/api/v1/tasks/${t.id}`);
    expect(detail.followers).toEqual([a.userId, b.userId]);

    // B, now a follower, gets `comment` for A's next comment; a mention of B is not doubled.
    await comment(a, t.id, 'Plain');
    await comment(a, t.id, `Again ${formatMention('Bo', b.userId)}`);
    expect((await notifications(b)).items.map((n) => n.type)).toEqual([
      'mention',
      'comment',
      'mention',
    ]);
    // The actor never hears about their own comments; A hears B's.
    expect((await notifications(a)).items).toEqual([]);
    await comment(b, t.id, 'Reply');
    expect((await notifications(a)).items.map((n) => [n.type, n.actor?.id])).toEqual([
      ['comment', b.userId],
    ]);
    // An edit that adds a mention notifies only the newly mentioned.
    const own = await comment(b, t.id, 'Note');
    await b.ok('PATCH', `/api/v1/comments/${own.id}`, {
      body: `Note ${formatMention('Ann', a.userId)}`,
    });
    expect((await notifications(a)).items[0]?.type).toBe('mention');
  });
});

describe('followers (WP 6.4, FR-COL-4)', () => {
  it('auto-follows creator, assignee and commenters; an unfollow (mute) blocks auto-follow', async () => {
    const { a, b, org } = await team();
    const t = await createTask(a, { title: 'T', assigneeId: b.userId }, org.id);
    const detail = () => a.ok<TaskDetail>('GET', `/api/v1/tasks/${t.id}`);
    expect((await detail()).followers).toEqual([a.userId, b.userId]);

    const off = await b.ok<FollowState>('DELETE', `/api/v1/tasks/${t.id}/followers/me`);
    expect(off.followers).toEqual([a.userId]);
    await comment(b, t.id, 'Still muted');
    await patch(a, t.id, { assigneeId: a.userId });
    await patch(a, t.id, { assigneeId: b.userId });
    expect((await detail()).followers).toEqual([a.userId]);
    await comment(a, t.id, 'Hello');
    expect((await notifications(b)).items.map((n) => n.type)).not.toContain('comment');

    const on = await b.ok<FollowState>('PUT', `/api/v1/tasks/${t.id}/followers/me`);
    expect(on.followers).toEqual([a.userId, b.userId]);
    expect(
      (await b.ok<FollowState>('PUT', `/api/v1/tasks/${t.id}/followers/me`)).followers,
    ).toEqual([a.userId, b.userId]);
  });

  it('personal orgs have no followers', async () => {
    const { a } = await team();
    const t = await createTask(a, { title: 'Mine' });
    expect((await a.ok<TaskDetail>('GET', `/api/v1/tasks/${t.id}`)).followers).toEqual([]);
    const res = await a.call('PUT', `/api/v1/tasks/${t.id}/followers/me`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as Problem).code).toBe('personal_org');
  });
});

describe('notifications (WP 6.5, FR-NOT-1/4)', () => {
  it('completed goes to the creator; due_changed to the assignee; never for one’s own action', async () => {
    const { a, b, org } = await team();
    const t = await createTask(a, { title: 'T', assigneeId: b.userId }, org.id);
    await b.ok('POST', `/api/v1/tasks/${t.id}/complete`, { completed: true });
    expect((await notifications(a)).items.map((n) => n.type)).toEqual(['completed']);
    const own = await createTask(a, { title: 'Own' }, org.id);
    await a.ok('POST', `/api/v1/tasks/${own.id}/complete`, { completed: true });
    expect((await notifications(a)).items).toHaveLength(1);

    await patch(a, t.id, { dueDate: '2026-10-09' });
    // Only the start date changes: the due date and time as shown stay, so nothing is sent.
    await patch(a, t.id, { dueDate: '2026-10-09', startDate: '2026-10-08' });
    await patch(b, t.id, { dueDate: '2026-10-10' });
    const forB = (await notifications(b)).items;
    expect(forB.map((n) => [n.type, n.data])).toEqual([
      ['due_changed', { from: null, to: { dueDate: '2026-10-09', dueTime: null } }],
      ['assigned', {}],
    ]);
  });

  it('invite_accepted goes to whoever made the invite', async () => {
    const { a, c, org } = await team();
    const { url } = await a.ok<{ url: string }>(
      'POST',
      `/api/v1/orgs/${org.id}/invites`,
      { role: 'member' },
      201,
    );
    await c.ok('POST', `/api/v1/invites/${url.split('/invite/')[1]}/accept`);
    const items = (await notifications(a)).items;
    expect(items.map((n) => [n.type, n.task, n.actor?.id, n.data])).toEqual([
      ['invite_accepted', null, c.userId, { userId: c.userId }],
    ]);
  });

  it('an in-app pref switched off creates nothing when no other channel reaches the user', async () => {
    const { a, b, org, db } = await team();
    const prefs = await b.ok<NotificationPrefs>('GET', '/api/v1/me/notification-prefs');
    expect(prefs.prefs).toHaveLength(23);
    const put = await b.ok<NotificationPrefs>('PUT', '/api/v1/me/notification-prefs', {
      prefs: [{ type: 'assigned', channel: 'inapp', enabled: false }],
    });
    expect(put.prefs.find((p) => p.type === 'assigned' && p.channel === 'inapp')?.enabled).toBe(
      false,
    );
    await createTask(a, { title: 'Quiet', assigneeId: b.userId }, org.id);
    expect((await notifications(b)).items).toEqual([]);
    // No push device and no SMTP: nothing else could deliver it, so no row at all.
    expect(db.orm.select().from(notification).all()).toEqual([]);
  });

  it('marks read and unread by id or all, with the count on every stream of the user', async () => {
    const { a, b, org } = await team();
    for (const title of ['1', '2', '3']) {
      await createTask(a, { title, assigneeId: b.userId }, org.id);
    }
    const [s1, s2] = [await listen(b), await listen(b)];
    const page = await notifications(b);
    expect(page.items.map((n) => n.task?.title)).toEqual(['3', '2', '1']);
    expect(page.unreadCount).toBe(3);
    const [n3, n2] = page.items;
    expect(await b.ok('POST', '/api/v1/notifications/read', { ids: [n3?.id, n2?.id] })).toEqual({
      unreadCount: 1,
    });
    for (const s of [s1, s2]) {
      await until(() => notificationsOf(s).length > 0, 1_000, 'count event');
      expect(notificationsOf(s)[0]).toEqual({ unreadCount: 1, notification: null });
    }
    expect((await notifications(b, '?unread=true')).items.map((n) => n.task?.title)).toEqual(['1']);
    expect(await b.ok('POST', '/api/v1/notifications/unread', { ids: [n3?.id] })).toEqual({
      unreadCount: 2,
    });
    expect(await b.ok('POST', '/api/v1/notifications/read', { all: true })).toEqual({
      unreadCount: 0,
    });
    // Someone else's IDs change nothing.
    expect(await a.ok('POST', '/api/v1/notifications/unread', { ids: [n2?.id] })).toEqual({
      unreadCount: 0,
    });
    const paged = await notifications(b, '?limit=2');
    expect(paged.items).toHaveLength(2);
    const rest = await notifications(b, `?limit=2&cursor=${paged.nextCursor}`);
    expect(rest.items.map((n) => n.task?.title)).toEqual(['1']);
    expect(rest.nextCursor).toBeNull();
  });
});

describe('member removal (05 §4.2)', () => {
  it('AC-6.4 removing B unassigns B’s tasks, removes B’s groups, follows and notifications', async () => {
    const { a, b, db, org } = await team();
    const t1 = await createTask(b, { title: 'B one' }, org.id);
    const t2 = await createTask(a, { title: 'B two', assigneeId: b.userId }, org.id);
    await comment(a, t1.id, `cc ${formatMention('Bo', b.userId)}`);
    expect((await notifications(b)).unreadCount).toBe(2);
    const sb = await listen(b);

    await a.ok('DELETE', `/api/v1/orgs/${org.id}/members/${b.userId}`, undefined, 204);

    const unassigned = await everyone(a, org.id, '&assignee=none');
    expect(unassigned.items.map((t) => t.title).sort()).toEqual(['B one', 'B two']);
    expect(
      db.orm
        .select()
        .from(taskGroup)
        .where(and(eq(taskGroup.userId, b.userId), eq(taskGroup.orgId, org.id)))
        .all(),
    ).toEqual([]);
    expect(db.orm.select().from(follower).where(eq(follower.userId, b.userId)).all()).toEqual([]);
    expect(
      db.orm.select().from(notification).where(eq(notification.userId, b.userId)).all(),
    ).toEqual([]);
    expect((await notifications(b)).unreadCount).toBe(0);
    for (const id of [t1.id, t2.id]) {
      const last = (await activities(a, id)).at(-1);
      expect(last).toMatchObject({
        type: 'assigned',
        actorId: null,
        via: 'system',
        data: { from: b.userId, to: null },
      });
    }
    await until(() => sb.keys.includes('notifications'), 1_000, 'B notifications key');
    expect(
      db.orm.select().from(activity).where(eq(activity.orgId, org.id)).all().length,
    ).toBeGreaterThan(0);
  });
});

describe('search, export and retention of comments', () => {
  it('indexes live comments (mentions as names) and drops deleted ones', async () => {
    const { a, b, org } = await team();
    const t = await createTask(a, { title: 'Quarterly report' }, org.id);
    const search = async (q: string) =>
      (await a.ok<SearchHit[]>('GET', `/api/v1/search?q=${encodeURIComponent(q)}`)).map(
        (h) => h.task.id,
      );
    const c1 = await comment(a, t.id, `Budget numbers for ${formatMention('Bo Berg', b.userId)}`);
    expect(await search('budget')).toEqual([t.id]);
    expect(await search('berg')).toEqual([t.id]);
    expect(await search(b.userId.slice(0, 8))).toEqual([]);
    await a.ok('PATCH', `/api/v1/comments/${c1.id}`, { body: 'Forecast instead' });
    expect(await search('budget')).toEqual([]);
    expect(await search('forecast')).toEqual([t.id]);
    await a.ok('DELETE', `/api/v1/comments/${c1.id}`, undefined, 204);
    expect(await search('forecast')).toEqual([]);
    await a.ok('POST', `/api/v1/comments/${c1.id}/restore`);
    expect(await search('forecast')).toEqual([t.id]);
  });

  it('exports the comments of the exported tasks, in JSON and Markdown', async () => {
    const { a, b, org } = await team({ clock: () => Date.UTC(2026, 9, 2, 12) });
    const t = await createTask(a, { title: 'Exported' }, org.id);
    const gone = await comment(b, t.id, 'Removed');
    await b.ok('DELETE', `/api/v1/comments/${gone.id}`, undefined, 204);
    const kept = await comment(b, t.id, `Hi ${formatMention('Ann', a.userId)}\nsecond line`);
    const theirs = await createTask(b, { title: 'Not mine' }, org.id);
    await comment(b, theirs.id, 'Elsewhere');

    const data = await a.ok<OrgExport>('GET', `/api/v1/orgs/${org.id}/export?format=json`);
    expect(data.comments).toEqual([{ ...kept, authorName: 'Bo Berg' }]);
    const res = await a.call('GET', `/api/v1/orgs/${org.id}/export?format=markdown`);
    const md = await res.text();
    expect(md).toContain(
      '- [ ] Exported\n\n  > **Bo Berg** (2026-10-02):\n  > Hi @Ann\n  > second line\n',
    );
  });

  it('purges deleted comments after 30 days and read notifications after 90', async () => {
    let now = Date.UTC(2026, 9, 1);
    const { a, b, app, org } = await team({ clock: () => now });
    const t = await createTask(a, { title: 'T', assigneeId: b.userId }, org.id);
    await createTask(a, { title: 'U', assigneeId: b.userId }, org.id);
    const c1 = await comment(a, t.id, 'old');
    await a.ok('DELETE', `/api/v1/comments/${c1.id}`, undefined, 204);
    const [read] = (await notifications(b)).items;
    await b.ok('POST', '/api/v1/notifications/read', { ids: [read?.id] });

    expect(app.services.retention.purge(now + 29 * DAY)).toMatchObject({
      comments: 0,
      notifications: 0,
    });
    expect(app.services.retention.purge(now + 31 * DAY)).toMatchObject({ comments: 1 });
    expect((await a.call('POST', `/api/v1/comments/${c1.id}/restore`)).status).toBe(404);
    expect(app.services.retention.purge(now + 91 * DAY)).toMatchObject({ notifications: 1 });
    now += 91 * DAY;
    // Two assignments and A's comment (B follows the task); the read one is gone.
    expect((await notifications(b)).items.map((n) => n.type)).toEqual(['assigned', 'assigned']);
  });
});
