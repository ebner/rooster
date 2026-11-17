// ADR 0072: moving tasks between organisations (POST /tasks/move-to-org and its preview).

import { uuidv7 } from '@rooster/core/ids';
import type {
  ActivityPage,
  NotificationPage,
  Org,
  Problem,
  SearchResult,
  Tag,
  Task,
  TaskDetail,
  TaskMoveToOrgPreview,
  TaskMoveToOrgResult,
} from '@rooster/core/schemas';
import { and, eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  activity,
  attachment,
  follower,
  idempotency,
  notification,
  placement,
  task,
  taskExpansion,
  taskFormerSeq,
  taskReminder,
} from '../src/db/schema/index.ts';
import type { DomainEvent } from '../src/events/bus.ts';
import { actorOf, bearer, openStream, pat } from './grant-helpers.ts';
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

const DAY = 86_400_000;

/**
 * Ann owns Kestrel (with Bo and Dee) and Riverside (with Cy and Dee). Bo is only in Kestrel,
 * Cy only in Riverside, Dee in both.
 */
async function world() {
  let now = Date.UTC(2026, 10, 1, 8);
  const ctx = listCtx({ clock: () => (now += 1) });
  const ann = ctx.user('ann@example.com', 'Ann Andersson');
  const bo = ctx.user('bo@example.com', 'Bo Berg');
  const cy = ctx.user('cy@example.com', 'Cy Carlsson');
  const dee = ctx.user('dee@example.com', 'Dee Dahl');
  const kestrel = await sharedOrg(ann, [bo, dee], 'Kestrel');
  const riverside = await sharedOrg(ann, [cy, dee], 'Riverside');
  ctx.db.orm.delete(notification).run();
  const events: DomainEvent[] = [];
  ctx.app.services.events.on((e) => events.push(e));
  return { ctx, ann, bo, cy, dee, kestrel, riverside, events, now: () => now };
}

const move = (c: Caller, body: Record<string, unknown>, headers?: Record<string, string>) =>
  c.ok<TaskMoveToOrgResult>('POST', '/api/v1/tasks/move-to-org', body, 200, headers);

async function problem(res: Response, status: number): Promise<Problem> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as Problem;
}

const preview = (c: Caller, ids: string[], orgId: string) =>
  c.ok<TaskMoveToOrgPreview>(
    'GET',
    `/api/v1/tasks/move-to-org/preview?ids=${ids.join(',')}&orgId=${orgId}`,
  );

function rowOf(ctx: ReturnType<typeof listCtx>, id: string) {
  const row = ctx.db.orm.select().from(task).where(eq(task.id, id)).get();
  if (row === undefined) throw new Error(`no task ${id}`);
  return row;
}

/** A root with subtasks: S1 (Bo; with S1a in Trash), S2 (Dee), S3 (unassigned). */
async function tree(w: Awaited<ReturnType<typeof world>>) {
  const { ann, bo, dee, kestrel } = w;
  const root = await createTask(ann, { title: 'Plan the move' }, kestrel.id);
  const s1 = await createTask(
    ann,
    { title: 'Book a van', parentId: root.id, assigneeId: bo.userId },
    kestrel.id,
  );
  const s1a = await createTask(ann, { title: 'Compare prices', parentId: s1.id }, kestrel.id);
  const s2 = await createTask(
    ann,
    { title: 'Pack books', parentId: root.id, assigneeId: dee.userId },
    kestrel.id,
  );
  const s3 = await createTask(
    ann,
    { title: 'Label boxes', parentId: root.id, assigneeId: null },
    kestrel.id,
  );
  await ann.ok('DELETE', `/api/v1/tasks/${s1a.id}`, undefined, 204);
  return { root, s1, s1a, s2, s3 };
}

describe('ADR 0072 move tasks between organisations', () => {
  it('moves the whole subtree (Trash included) with new numbers in tree order', async () => {
    const w = await world();
    const { ctx, ann, kestrel, riverside } = w;
    const { root, s1, s1a, s2, s3 } = await tree(w);
    const before = ctx.db.orm.select().from(task).where(eq(task.orgId, riverside.id)).all();
    expect(before).toHaveLength(0);
    const result = await move(ann, { ids: [root.id], orgId: riverside.id });
    expect(result.orgId).toBe(riverside.id);
    expect(result.movedIds).toEqual([root.id, s1.id, s1a.id, s2.id, s3.id]);
    expect(result.tasks.map((t) => t.id)).toEqual([root.id]);
    expect(result.tasks[0]?.orgId).toBe(riverside.id);
    const rows = result.movedIds.map((id) => rowOf(ctx, id));
    expect(rows.every((r) => r.orgId === riverside.id)).toBe(true);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    // The subtree keeps its shape and the deleted subtask stays in Trash.
    expect(rowOf(ctx, s1a.id).parentId).toBe(s1.id);
    expect(rowOf(ctx, s1a.id).deletedAt).not.toBeNull();
    const trash = await ann.ok<{ items: Task[] }>('GET', `/api/v1/orgs/${riverside.id}/trash`);
    expect(trash.items.map((t) => t.id)).toEqual([s1a.id]);
    // Gone from the source list.
    expect((await myList(ann, kestrel.id)).tasks.map((t) => t.id)).not.toContain(root.id);
  });

  it('old numbers keep resolving, and a task moving back gets its number back', async () => {
    const w = await world();
    const { ctx, ann, kestrel, riverside } = w;
    const { root, s1 } = await tree(w);
    await createTask(ann, { title: 'Already there' }, riverside.id);
    const oldSeq = rowOf(ctx, root.id).seq;
    const oldSub = rowOf(ctx, s1.id).seq;
    await move(ann, { ids: [root.id], orgId: riverside.id });
    expect(rowOf(ctx, root.id).seq).toBe(2);
    const resolved = await ann.ok<Task>(
      'GET',
      `/api/v1/tasks/resolve?ref=${encodeURIComponent(`${kestrel.slug}#${oldSeq}`)}`,
    );
    expect(resolved.id).toBe(root.id);
    expect(resolved.orgId).toBe(riverside.id);
    // Bo is not in Riverside: the old number is a 404 for him.
    expect(
      (
        await w.bo.call(
          'GET',
          `/api/v1/tasks/resolve?ref=${encodeURIComponent(`${kestrel.slug}#${oldSeq}`)}`,
        )
      ).status,
    ).toBe(404);
    await move(ann, { ids: [root.id], orgId: kestrel.id });
    expect(rowOf(ctx, root.id).seq).toBe(oldSeq);
    expect(rowOf(ctx, s1.id).seq).toBe(oldSub);
    expect(rowOf(ctx, root.id).orgId).toBe(kestrel.id);
    // Its Riverside numbers are remembered now, and Kestrel's are no longer former ones.
    const former = ctx.db.orm
      .select()
      .from(taskFormerSeq)
      .where(eq(taskFormerSeq.taskId, root.id))
      .all();
    expect(former.map((f) => [f.orgId, f.seq])).toEqual([[riverside.id, 2]]);
    // The org counter never reuses numbers.
    const next = await createTask(ann, { title: 'New' }, riverside.id);
    expect(next.seq).toBe(7);
  });

  it('a subtask moved alone detaches and arrives top-level', async () => {
    const w = await world();
    const { ctx, ann, riverside } = w;
    const { root, s2 } = await tree(w);
    const edit = w.now() + 10;
    const result = await move(
      ann,
      { ids: [s2.id], orgId: riverside.id },
      { 'X-Rooster-Edit-Time': String(edit) },
    );
    expect(result.movedIds).toEqual([s2.id]);
    const row = rowOf(ctx, s2.id);
    expect(row.parentId).toBeNull();
    expect(row.subtaskPosition).toBeNull();
    expect(row.assigneeId).toBe(ann.userId);
    expect(JSON.parse(row.fieldClock)).toMatchObject({ parent: edit, assignee: edit });
    const detail = await ann.ok<TaskDetail>('GET', `/api/v1/tasks/${root.id}`);
    expect(detail.subtasks.map((t) => t.id)).not.toContain(s2.id);
  });

  it('a selected task whose ancestor is selected travels with it; roots keep request order', async () => {
    const w = await world();
    const { ctx, ann, kestrel, riverside } = w;
    const { root, s1 } = await tree(w);
    const other = await createTask(ann, { title: 'Other' }, kestrel.id);
    const result = await move(ann, { ids: [other.id, s1.id, root.id], orgId: riverside.id });
    expect(result.tasks.map((t) => t.id)).toEqual([other.id, root.id]);
    expect(rowOf(ctx, s1.id).parentId).toBe(root.id);
    const prio = await groupNamed(ann, 'Today', riverside.id);
    expect((await titlesIn(ann, prio.id, riverside.id)).slice(0, 2)).toEqual([
      'Other',
      'Plan the move',
    ]);
  });

  it('assignees: roots the mover’s, target members kept, others the new parent’s', async () => {
    const w = await world();
    const { ctx, ann, dee, riverside } = w;
    const { root, s1, s1a, s2, s3 } = await tree(w);
    const pre = await preview(ann, [root.id], riverside.id);
    // Bo's two tasks change: S1 and its child (Ann's by default, under Bo's task → Bo).
    expect(rowOf(ctx, s1a.id).assigneeId).toBe(w.bo.userId);
    expect(pre.reassigned).toBe(2);
    await move(ann, { ids: [root.id], orgId: riverside.id });
    expect(rowOf(ctx, root.id).assigneeId).toBe(ann.userId);
    expect(rowOf(ctx, s1.id).assigneeId).toBe(ann.userId);
    expect(rowOf(ctx, s1a.id).assigneeId).toBe(ann.userId);
    expect(rowOf(ctx, s2.id).assigneeId).toBe(dee.userId);
    expect(rowOf(ctx, s3.id).assigneeId).toBeNull();
    // Dee's subtask sits at the top of her Riverside Inbox (05 §4.1).
    const inbox = await inboxOf(dee, riverside.id);
    expect((await titlesIn(dee, inbox.id, riverside.id))[0]).toBe('Pack books');
    expect(ctx.db.orm.select().from(placement).where(eq(placement.taskId, s1.id)).get()).toBe(
      undefined,
    );
  });

  it('into a personal org every task becomes the owner’s', async () => {
    const w = await world();
    const { ctx, ann } = w;
    const { root, s2, s3 } = await tree(w);
    const me = await ann.ok<{ orgs: Org[] }>('GET', '/api/v1/me');
    const personal = me.orgs.find((o) => o.isPersonal) as Org;
    const pre = await preview(ann, [root.id], personal.id);
    expect(pre.reassigned).toBe(4);
    await move(ann, { ids: [root.id], orgId: personal.id });
    expect(rowOf(ctx, s2.id).assigneeId).toBe(ann.userId);
    expect(rowOf(ctx, s3.id).assigneeId).toBe(ann.userId);
    // No followers in a personal org.
    expect(
      ctx.db.orm.select().from(follower).where(eq(follower.taskId, root.id)).all(),
    ).toHaveLength(0);
  });

  it('tags are matched by name and created when missing', async () => {
    const w = await world();
    const { ann, kestrel, riverside } = w;
    const urgentR = await ann.ok<Tag>(
      'POST',
      `/api/v1/orgs/${riverside.id}/tags`,
      { name: 'urgent' },
      201,
    );
    const t = await createTask(ann, { title: 'Tagged', tagNames: ['Urgent', 'Home'] }, kestrel.id);
    const pre = await preview(ann, [t.id], riverside.id);
    expect(pre.newTags).toEqual(['Home']);
    const result = await move(ann, { ids: [t.id], orgId: riverside.id });
    const tags = await ann.ok<Tag[]>('GET', `/api/v1/orgs/${riverside.id}/tags`);
    const home = tags.find((x) => x.name === 'Home');
    expect(home).toBeDefined();
    expect(result.tasks[0]?.tagIds).toEqual([urgentR.id, home?.id]);
    // The source tags stay where they were.
    const source = await ann.ok<Tag[]>('GET', `/api/v1/orgs/${kestrel.id}/tags`);
    expect(source.map((x) => x.name).sort()).toEqual(['Home', 'Urgent']);
  });

  it('lands at the top of the first normal group, of a chosen group, or at the intent', async () => {
    const w = await world();
    const { ann, kestrel, riverside } = w;
    const first = await groupNamed(ann, 'Today', riverside.id);
    const prio = await groupNamed(ann, 'Prio', riverside.id);
    await createTask(ann, { title: 'Existing', groupId: first.id }, riverside.id);
    const x = await createTask(ann, { title: 'X' }, kestrel.id);
    await move(ann, { ids: [x.id], orgId: riverside.id });
    expect(await titlesIn(ann, first.id, riverside.id)).toEqual(['X', 'Existing']);
    const y = await createTask(ann, { title: 'Y' }, kestrel.id);
    await move(ann, { ids: [y.id], orgId: riverside.id, groupId: prio.id });
    expect(await titlesIn(ann, prio.id, riverside.id)).toEqual(['Y']);
    const z = await createTask(ann, { title: 'Z' }, kestrel.id);
    const existing = (await myList(ann, riverside.id)).tasks.find((t) => t.title === 'Existing');
    await move(ann, { ids: [z.id], orgId: riverside.id, groupId: first.id, afterId: existing?.id });
    expect(await titlesIn(ann, first.id, riverside.id)).toEqual(['X', 'Existing', 'Z']);
    // The `pos:*` clocks of the old placements are gone.
    expect(Object.keys(JSON.parse(rowOf(w.ctx, z.id).fieldClock))).not.toContain(
      `pos:${ann.userId}`,
    );
  });

  it('an intent without a group lands in the anchor’s group (undo, chunked selections)', async () => {
    const w = await world();
    const { ann, kestrel, riverside } = w;
    const prio = await groupNamed(ann, 'Prio', riverside.id);
    const a = await createTask(ann, { title: 'A' }, kestrel.id);
    const b = await createTask(ann, { title: 'B' }, kestrel.id);
    const c = await createTask(ann, { title: 'C' }, kestrel.id);
    await move(ann, { ids: [a.id], orgId: riverside.id, groupId: prio.id });
    await move(ann, { ids: [c.id], orgId: riverside.id, groupId: prio.id, afterId: a.id });
    // The next chunk: no group, anchored after the last moved task.
    await move(ann, { ids: [b.id], orgId: riverside.id, groupId: null, afterId: a.id });
    expect(await titlesIn(ann, prio.id, riverside.id)).toEqual(['A', 'B', 'C']);
    // Undo: back to Kestrel, before the anchor in Ann's Kestrel list.
    const today = await groupNamed(ann, 'Today', kestrel.id);
    const d = await createTask(ann, { title: 'D', groupId: today.id }, kestrel.id);
    await move(ann, { ids: [b.id], orgId: kestrel.id, beforeId: d.id });
    expect(await titlesIn(ann, today.id, kestrel.id)).toEqual(['B', 'D']);
    // An anchor that is not in Ann's list in the target org: 422.
    for (const body of [
      { ids: [c.id], orgId: kestrel.id, afterId: a.id },
      { ids: [c.id], orgId: kestrel.id, beforeId: uuidv7() },
    ]) {
      const res = await ann.call('POST', '/api/v1/tasks/move-to-org', body);
      expect((await problem(res, 422)).code).toBe('validation_failed');
    }
  });

  it('cleans up rows of people outside the target, re-points the rest and tells who lost it', async () => {
    const w = await world();
    const { ctx, ann, bo, cy, dee, kestrel, riverside } = w;
    const { root, s1 } = await tree(w);
    const due = { dueDate: '2026-12-01' };
    await ann.ok('PATCH', `/api/v1/tasks/${root.id}`, due);
    for (const c of [bo, dee]) {
      await c.ok('PUT', `/api/v1/tasks/${root.id}/followers/me`);
      await c.ok('POST', `/api/v1/tasks/${root.id}/reminders`, { offsetMinutes: 60 }, 201);
      await c.ok('PUT', `/api/v1/tasks/${root.id}/expanded`, undefined, 204);
    }
    // Both get a notification about the root (a comment by Ann).
    await ann.ok('POST', `/api/v1/tasks/${root.id}/comments`, { body: 'Moving day' }, 201);
    const deeBefore = ctx.db.orm
      .select()
      .from(notification)
      .where(and(eq(notification.userId, dee.userId), eq(notification.taskId, root.id)))
      .all();
    expect(deeBefore.length).toBeGreaterThan(0);
    // A stored response of Bo that names the task, and one that does not.
    ctx.db.orm
      .insert(idempotency)
      .values([
        { opId: 'a', userId: bo.userId, status: 200, response: `{"x":"${root.id}"}`, createdAt: 1 },
        { opId: 'b', userId: bo.userId, status: 200, response: '{}', createdAt: 1 },
      ])
      .run();

    await move(ann, { ids: [root.id], orgId: riverside.id });
    const of = (table: typeof follower | typeof taskReminder | typeof taskExpansion, u: string) =>
      ctx.db.orm
        .select()
        .from(table)
        .where(and(eq(table.userId, u), eq(table.taskId, root.id)))
        .all().length;
    expect([
      of(follower, bo.userId),
      of(taskReminder, bo.userId),
      of(taskExpansion, bo.userId),
    ]).toEqual([0, 0, 0]);
    expect([
      of(follower, dee.userId),
      of(taskReminder, dee.userId),
      of(taskExpansion, dee.userId),
    ]).toEqual([1, 1, 1]);
    // Bo's notifications about the tasks are gone; Dee's now belong to Riverside.
    expect(
      ctx.db.orm
        .select()
        .from(notification)
        .where(
          and(eq(notification.userId, bo.userId), inArray(notification.taskId, [root.id, s1.id])),
        )
        .all(),
    ).toHaveLength(0);
    const deeAfter = await dee.ok<NotificationPage>('GET', '/api/v1/notifications');
    const repointed = deeAfter.items.filter((n) => n.task?.id === root.id);
    expect(repointed.length).toBe(deeBefore.length);
    expect(repointed.every((n) => n.orgId === riverside.id)).toBe(true);
    expect(repointed[0]?.task?.seq).toBe(rowOf(ctx, root.id).seq);
    // Bo (assignee of S1, follower of the root) is told once per moved root; Dee and Ann not.
    const boInbox = await bo.ok<NotificationPage>('GET', '/api/v1/notifications');
    const away = boInbox.items.filter((n) => n.type === 'moved_away');
    expect(away).toHaveLength(1);
    expect(away[0]).toMatchObject({
      orgId: kestrel.id,
      task: null,
      actor: { id: ann.userId },
      data: { taskTitle: 'Plan the move' },
    });
    expect(deeAfter.items.some((n) => n.type === 'moved_away')).toBe(false);
    expect(
      (await ann.ok<NotificationPage>('GET', '/api/v1/notifications')).items.some(
        (n) => n.type === 'moved_away',
      ),
    ).toBe(false);
    expect(
      (await cy.ok<NotificationPage>('GET', '/api/v1/notifications')).items.some(
        (n) => n.type === 'moved_away',
      ),
    ).toBe(false);
    // Only the stored response naming the task was forgotten.
    expect(
      ctx.db.orm
        .select({ opId: idempotency.opId })
        .from(idempotency)
        .where(eq(idempotency.userId, bo.userId))
        .all()
        .map((r) => r.opId),
    ).toEqual(['b']);
    // Bo can no longer open it.
    expect((await bo.call('GET', `/api/v1/tasks/${root.id}`)).status).toBe(404);
  });

  it('records org_moved on the roots only; activity and attachments follow the task', async () => {
    const w = await world();
    const { ctx, ann, bo, kestrel, riverside } = w;
    const { root, s1 } = await tree(w);
    ctx.db.orm
      .insert(attachment)
      .values({
        id: uuidv7(),
        taskId: s1.id,
        orgId: kestrel.id,
        uploaderId: bo.userId,
        filename: 'van.pdf',
        mime: 'application/pdf',
        size: 10,
        storage: 'local',
        key: `attachments/${kestrel.id}/x`,
        createdAt: 1,
      })
      .run();
    await move(ann, { ids: [root.id], orgId: riverside.id });
    const feed = await ann.ok<ActivityPage>('GET', `/api/v1/tasks/${root.id}/activity`);
    const moved = feed.items.flatMap((i) =>
      i.kind === 'activity' && i.activity.type === 'org_moved' ? [i.activity] : [],
    );
    expect(moved).toHaveLength(1);
    expect(moved[0]?.data).toEqual({ fromOrgId: kestrel.id, toOrgId: riverside.id });
    const subFeed = await ann.ok<ActivityPage>('GET', `/api/v1/tasks/${s1.id}/activity`);
    expect(
      subFeed.items.some((i) => i.kind === 'activity' && i.activity.type === 'org_moved'),
    ).toBe(false);
    const orgs = ctx.db.orm
      .selectDistinct({ orgId: activity.orgId })
      .from(activity)
      .where(inArray(activity.taskId, [root.id, s1.id]))
      .all();
    expect(orgs).toEqual([{ orgId: riverside.id }]);
    expect(
      ctx.db.orm.select().from(attachment).where(eq(attachment.taskId, s1.id)).get()?.orgId,
    ).toBe(riverside.id);
  });

  it('reindexes search: found in the target, not in the source', async () => {
    const w = await world();
    const { ann, kestrel, riverside } = w;
    const t = await createTask(ann, { title: 'Zeppelin tickets' }, kestrel.id);
    await move(ann, { ids: [t.id], orgId: riverside.id });
    const inTarget = await ann.ok<SearchResult>(
      'GET',
      `/api/v1/search?q=zeppelin&orgId=${riverside.id}`,
    );
    expect(inTarget.map((h) => h.task.id)).toEqual([t.id]);
    const inSource = await ann.ok<SearchResult>(
      'GET',
      `/api/v1/search?q=zeppelin&orgId=${kestrel.id}`,
    );
    expect(inSource).toEqual([]);
  });

  it('tells both orgs: the source lists and the target members', async () => {
    const w = await world();
    const { ann, bo, cy, kestrel, riverside, events } = w;
    const { root, s1 } = await tree(w);
    events.length = 0;
    await move(ann, { ids: [root.id], orgId: riverside.id });
    const event = events.find((e) => e.type === 'task.org_moved');
    expect(event).toBeDefined();
    const keysFor = (userId: string, org: string) =>
      (event as DomainEvent).audiences
        .filter((a) => a.org === org && a.userIds.includes(userId))
        .flatMap((a) => a.keys);
    // Bo had S1 in his list: his Kestrel list and the task keys refresh.
    expect(keysFor(bo.userId, kestrel.id)).toContainEqual(['my-list', kestrel.id]);
    expect(keysFor(bo.userId, kestrel.id)).toContainEqual(['task', s1.id]);
    expect(keysFor(bo.userId, kestrel.id)).toContainEqual(['everyone', kestrel.id]);
    expect(keysFor(bo.userId, riverside.id)).toEqual([]);
    expect(keysFor(cy.userId, riverside.id)).toContainEqual(['everyone', riverside.id]);
    expect(keysFor(cy.userId, riverside.id)).toContainEqual(['task', root.id]);
    expect(keysFor(cy.userId, kestrel.id)).toEqual([]);
    expect(keysFor(ann.userId, riverside.id)).toContainEqual(['my-list', riverside.id]);
    // Bo's inbox lost notifications, and he got moved_away.
    const notified = events.filter((e) =>
      e.audiences.some(
        (a) => a.userIds.includes(bo.userId) && a.keys.some((k) => k[0] === 'notifications'),
      ),
    );
    expect(notified.length).toBeGreaterThan(0);
  });

  it('a grant reading one source group gets the bare task prefix for a task it could read', async () => {
    const w = await world();
    const { ctx, ann, kestrel, riverside, events } = w;
    const today = await groupNamed(ann, 'Today', kestrel.id);
    const x = await createTask(ann, { title: 'X', groupId: today.id }, kestrel.id);
    const reader = await pat(ann, ['tasks:read'], {
      orgs: [{ orgId: kestrel.id, read: { groups: [today.id] }, write: 'none' }],
    });
    const actor = await actorOf(ctx, reader.token);
    const access = ctx.app.services.grants.streamAccess(actor);
    const stream = openStream(ctx, actor);
    events.length = 0;
    await move(ann, { ids: [x.id], orgId: riverside.id });
    const event = events.find((e) => e.type === 'task.org_moved') as DomainEvent;
    const keys = access.filterKeys?.(
      kestrel.id,
      event.audiences.filter((a) => a.org === kestrel.id).flatMap((a) => a.keys),
      event.priorGroups,
    );
    expect(keys).toContainEqual(['my-list', kestrel.id]);
    expect(keys).toContainEqual(['task']);
    expect(keys).not.toContainEqual(['task', x.id]);
    expect(
      access.filterKeys?.(
        riverside.id,
        event.audiences.filter((a) => a.org === riverside.id).flatMap((a) => a.keys),
        event.priorGroups,
      ),
    ).toEqual([]);
    stream.close();
  });

  it('a group-limited grant never sees the title of a task that moved away (Codex P1)', async () => {
    const w = await world();
    const { ctx, ann, bo, kestrel, riverside } = w;
    const today = await groupNamed(bo, 'Today', kestrel.id);
    // In Bo's Inbox, outside the one group his token may read.
    const hidden = await createTask(
      ann,
      { title: 'Secret plan', assigneeId: bo.userId },
      kestrel.id,
    );
    const limited = await pat(bo, ['tasks:read', 'notifications:read'], {
      orgs: [{ orgId: kestrel.id, read: { groups: [today.id] }, write: 'none' }],
    });
    const whole = await pat(bo, ['tasks:read', 'notifications:read'], {
      orgs: [{ orgId: kestrel.id, read: 'all', write: 'none' }],
    });
    await bearer(ctx, limited.token).problem('GET', `/api/v1/tasks/${hidden.id}`, undefined, 404);
    ctx.db.orm.delete(notification).run();
    await move(ann, { ids: [hidden.id], orgId: riverside.id });

    const browser = await bo.ok<NotificationPage>('GET', '/api/v1/notifications');
    expect(browser.items.map((n) => n.type)).toEqual(['moved_away']);

    const limitedPage = await bearer(ctx, limited.token).ok<NotificationPage>(
      'GET',
      '/api/v1/notifications',
    );
    expect(limitedPage.items).toEqual([]);
    expect(limitedPage.unreadCount).toBe(0);
    const preview = { ...browser.items[0], orgId: kestrel.id, taskId: null, type: 'moved_away' };
    const limitedActor = await actorOf(ctx, limited.token);
    expect(
      ctx.app.services.grants.streamAccess(limitedActor).notification?.({
        notification: preview,
        unreadCount: 1,
      }),
    ).toBeNull();

    // A grant that reads the whole source org could see the task anyway: it gets the notice.
    const wholePage = await bearer(ctx, whole.token).ok<NotificationPage>(
      'GET',
      '/api/v1/notifications',
    );
    expect(wholePage.items.map((n) => n.data.taskTitle)).toEqual(['Secret plan']);
  });

  it('a grant writing only some target groups can preview, then move into one (Codex P2)', async () => {
    const w = await world();
    const { ctx, ann, kestrel, riverside } = w;
    const prio = await groupNamed(ann, 'Prio', riverside.id);
    const today = await groupNamed(ann, 'Today', riverside.id);
    const token = await pat(ann, ['tasks:read', 'tasks:write'], {
      orgs: [
        { orgId: kestrel.id, read: 'all', write: 'all' },
        { orgId: riverside.id, read: 'all', write: { groups: [prio.id] } },
      ],
    });
    const api = bearer(ctx, token.token);
    const x = await createTask(ann, { title: 'X' }, kestrel.id);
    const path = `/api/v1/tasks/move-to-org/preview?ids=${x.id}&orgId=${riverside.id}`;
    expect((await api.ok<TaskMoveToOrgPreview>('GET', path)).tasks).toBe(1);
    expect((await api.ok<TaskMoveToOrgPreview>('GET', `${path}&groupId=${prio.id}`)).tasks).toBe(1);
    await api.problem('GET', `${path}&groupId=${today.id}`, undefined, 403);
    const moved = await api.ok<TaskMoveToOrgResult>('POST', '/api/v1/tasks/move-to-org', {
      ids: [x.id],
      orgId: riverside.id,
      groupId: prio.id,
    });
    expect(moved.tasks[0]?.placement?.groupId).toBe(prio.id);
  });

  it('errors: 404, 410, 422 same_org and mixed orgs', async () => {
    const w = await world();
    const { ann, bo, kestrel, riverside } = w;
    const { root, s1a } = await tree(w);
    const other = await createTask(ann, { title: 'Elsewhere' }, riverside.id);
    const post = (c: Caller, body: unknown) => c.call('POST', '/api/v1/tasks/move-to-org', body);
    expect(
      (await problem(await post(ann, { ids: [uuidv7()], orgId: riverside.id }), 404)).code,
    ).toBe('not_found');
    // Bo is not a member of Riverside.
    expect((await problem(await post(bo, { ids: [root.id], orgId: riverside.id }), 404)).code).toBe(
      'not_found',
    );
    // Cy cannot see the task.
    expect(
      (await problem(await post(w.cy, { ids: [root.id], orgId: riverside.id }), 404)).code,
    ).toBe('not_found');
    expect((await problem(await post(ann, { ids: [s1a.id], orgId: riverside.id }), 410)).code).toBe(
      'conflict_deleted',
    );
    expect((await problem(await post(ann, { ids: [root.id], orgId: kestrel.id }), 422)).code).toBe(
      'same_org',
    );
    expect(
      (await problem(await post(ann, { ids: [root.id, other.id], orgId: riverside.id }), 422)).code,
    ).toBe('validation_failed');
    // A group of another org (or someone else's) is a 404.
    const kestrelGroup = await groupNamed(ann, 'Today', kestrel.id);
    expect(
      (
        await problem(
          await post(ann, { ids: [root.id], orgId: riverside.id, groupId: kestrelGroup.id }),
          404,
        )
      ).code,
    ).toBe('not_found');
    expect(
      (
        await problem(
          await ann.call(
            'GET',
            `/api/v1/tasks/move-to-org/preview?ids=${root.id}&orgId=${kestrel.id}`,
          ),
          422,
        )
      ).code,
    ).toBe('same_org');
    // Nothing moved.
    expect(rowOf(w.ctx, root.id).orgId).toBe(kestrel.id);
  });

  it('is idempotent: a replay with the same key returns the stored response', async () => {
    const w = await world();
    const { ctx, ann, riverside } = w;
    const { root } = await tree(w);
    const key = { 'Idempotency-Key': uuidv7() };
    const first = await move(ann, { ids: [root.id], orgId: riverside.id }, key);
    const second = await move(ann, { ids: [root.id], orgId: riverside.id }, key);
    expect(second).toEqual(first);
    expect(rowOf(ctx, root.id).seq).toBe(first.tasks[0]?.seq);
  });

  it('preview: counts other people’s content and whether it reaches someone new', async () => {
    const w = await world();
    const { ctx, ann, bo, dee, kestrel, riverside } = w;
    const { root, s1, s1a } = await tree(w);
    // A task in Trash cannot be named, even under a named ancestor.
    expect(
      (
        await ann.call(
          'GET',
          `/api/v1/tasks/move-to-org/preview?ids=${root.id},${s1a.id}&orgId=${riverside.id}`,
        )
      ).status,
    ).toBe(410);
    await bo.ok('POST', `/api/v1/tasks/${s1.id}/comments`, { body: 'I can drive' }, 201);
    await ann.ok('POST', `/api/v1/tasks/${root.id}/comments`, { body: 'Mine' }, 201);
    ctx.db.orm
      .insert(attachment)
      .values({
        id: uuidv7(),
        taskId: root.id,
        orgId: kestrel.id,
        uploaderId: dee.userId,
        filename: 'plan.pdf',
        mime: 'application/pdf',
        size: 10,
        storage: 'local',
        key: `attachments/${kestrel.id}/y`,
        createdAt: 1,
      })
      .run();
    const result = await preview(ann, [s1.id, root.id], riverside.id);
    expect(result).toEqual({
      tasks: 1,
      subtasks: 4,
      comments: 1,
      attachments: 1,
      exposes: true,
      newTags: [],
      reassigned: 2,
    });
    // Nothing changed.
    expect(rowOf(ctx, root.id).orgId).toBe(kestrel.id);
    // Into Ann's personal org nobody new sees anything.
    const me = await ann.ok<{ orgs: Org[] }>('GET', '/api/v1/me');
    const personal = me.orgs.find((o) => o.isPersonal) as Org;
    expect((await preview(ann, [root.id], personal.id)).exposes).toBe(false);
    // Bad id lists are 422.
    expect(
      (await ann.call('GET', `/api/v1/tasks/move-to-org/preview?ids=,&orgId=${riverside.id}`))
        .status,
    ).toBe(422);
  });

  it('grants: write on the subtree and the landing group; org-wide write to create a tag', async () => {
    const w = await world();
    const { ctx, ann, kestrel, riverside } = w;
    const kToday = await groupNamed(ann, 'Today', kestrel.id);
    const rToday = await groupNamed(ann, 'Today', riverside.id);
    const rPrio = await groupNamed(ann, 'Prio', riverside.id);
    const groupsOnly = await pat(ann, ['tasks:read', 'tasks:write'], {
      orgs: [
        { orgId: kestrel.id, read: 'all', write: 'all' },
        { orgId: riverside.id, read: 'all', write: { groups: [rToday.id] } },
      ],
    });
    const api = bearer(ctx, groupsOnly.token);
    const plain = await createTask(ann, { title: 'Plain', groupId: kToday.id }, kestrel.id);
    const tagged = await createTask(
      ann,
      { title: 'Tagged', groupId: kToday.id, tagNames: ['Fresh'] },
      kestrel.id,
    );
    // Another group than the writable one: 403.
    expect(
      (
        await api.problem(
          'POST',
          '/api/v1/tasks/move-to-org',
          { ids: [plain.id], orgId: riverside.id, groupId: rPrio.id },
          403,
        )
      ).code,
    ).toBe('outside_grant');
    // A tag would have to be created: 403.
    expect(
      (
        await api.problem(
          'POST',
          '/api/v1/tasks/move-to-org',
          { ids: [tagged.id], orgId: riverside.id, groupId: rToday.id },
          403,
        )
      ).code,
    ).toBe('outside_grant');
    expect(rowOf(ctx, tagged.id).orgId).toBe(kestrel.id);
    await api.ok('POST', '/api/v1/tasks/move-to-org', {
      ids: [plain.id],
      orgId: riverside.id,
      groupId: rToday.id,
    });
    expect(rowOf(ctx, plain.id).orgId).toBe(riverside.id);
    // A grant that does not reach the target org: 404.
    const kestrelOnly = bearer(
      ctx,
      (
        await pat(ann, ['tasks:read', 'tasks:write'], {
          orgs: [{ orgId: kestrel.id, read: 'all', write: 'all' }],
        })
      ).token,
    );
    expect(
      (
        await kestrelOnly.problem(
          'POST',
          '/api/v1/tasks/move-to-org',
          { ids: [tagged.id], orgId: riverside.id },
          404,
        )
      ).code,
    ).toBe('not_found');
    // A grant without write on a subtask: the whole move is refused.
    const writeToday = bearer(
      ctx,
      (
        await pat(ann, ['tasks:read', 'tasks:write'], {
          orgs: [
            { orgId: kestrel.id, read: 'all', write: { groups: [kToday.id] } },
            { orgId: riverside.id, read: 'all', write: 'all' },
          ],
        })
      ).token,
    );
    const parent = await createTask(ann, { title: 'Parent', groupId: kToday.id }, kestrel.id);
    // Bo's subtask shows under Ann's row (writable), but Ann's own task below it has its own
    // place in her Inbox: outside a grant writing only in Today.
    const mid = await createTask(
      ann,
      { title: 'Bo’s part', parentId: parent.id, assigneeId: w.bo.userId },
      kestrel.id,
    );
    await createTask(
      ann,
      { title: 'Mine again', parentId: mid.id, assigneeId: ann.userId },
      kestrel.id,
    );
    const res = await writeToday.call('POST', '/api/v1/tasks/move-to-org', {
      ids: [parent.id],
      orgId: riverside.id,
    });
    expect(res.status).toBe(403);
    expect(rowOf(ctx, parent.id).orgId).toBe(kestrel.id);
  });

  it('due reminders and placements survive for target members', async () => {
    const w = await world();
    const { ctx, ann, riverside, kestrel } = w;
    const t = await createTask(ann, { title: 'Dentist', dueDate: '2026-12-01' }, kestrel.id);
    await ann.ok('POST', `/api/v1/tasks/${t.id}/reminders`, { at: w.now() + DAY }, 201);
    await move(ann, { ids: [t.id], orgId: riverside.id });
    expect(
      ctx.db.orm.select().from(taskReminder).where(eq(taskReminder.taskId, t.id)).all(),
    ).toHaveLength(1);
  });
});
