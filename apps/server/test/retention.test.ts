import type { Task } from '@rooster/core/schemas';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { idempotency, placement, task, taskGroup, verification } from '../src/db/schema/index.ts';
import { registerJobs } from '../src/jobs/register.ts';
import { createScheduler } from '../src/jobs/scheduler.ts';
import { captureLogger, testConfig } from './helpers.ts';
import {
  createTask,
  groupNamed,
  inboxOf,
  listCtx,
  myList,
  sharedOrg,
  titlesIn,
} from './list-helpers.ts';

const DAY = 86_400_000;

describe('trash purge (05 §4.5)', () => {
  it('hard-deletes tasks and groups deleted more than 30 days ago, re-homing placements', async () => {
    let now = Date.UTC(2026, 8, 1);
    const ctx = listCtx({ clock: () => now });
    const a = ctx.user('a@example.com');
    const prio = await groupNamed(a, 'Prio');
    const upcoming = await groupNamed(a, 'Upcoming');
    await createTask(a, { title: 'inbox' });
    const old = await createTask(a, { title: 'old', groupId: prio.id });
    const keep = await createTask(a, { title: 'keep 1', groupId: upcoming.id });
    const keep2 = await createTask(a, { title: 'keep 2', groupId: upcoming.id });
    await a.ok('DELETE', `/api/v1/tasks/${old.id}`, undefined, 204);
    // Upcoming goes with "delete tasks too"; its tasks keep their placement in it.
    await a.ok('DELETE', `/api/v1/groups/${upcoming.id}`, { deleteTasks: true }, 204);
    now += 20 * DAY;
    // One of them is restored meanwhile: it lands in the Inbox (its group is deleted)…
    await a.ok('POST', `/api/v1/tasks/${keep.id}/restore`);
    // …while the other's deletion is younger than its group's (e.g. a later replay), so it
    // outlives the group in Trash with its placement still in the deleted group.
    ctx.db.orm.update(task).set({ deletedAt: now }).where(eq(task.id, keep2.id)).run();
    now += 11 * DAY;
    const stranded = ctx.db.orm
      .select()
      .from(placement)
      .where(eq(placement.taskId, keep2.id))
      .get();
    expect(stranded?.groupId).toBe(upcoming.id);

    expect(ctx.app.services.retention.purge()).toMatchObject({ tasks: 1, groups: 1 });
    const ids = ctx.db.orm
      .select({ id: task.id })
      .from(task)
      .all()
      .map((r) => r.id);
    expect(ids).not.toContain(old.id);
    expect(ids).toEqual(expect.arrayContaining([keep.id, keep2.id]));
    expect(ctx.db.orm.select().from(taskGroup).where(eq(taskGroup.id, upcoming.id)).get()).toBe(
      undefined,
    );
    // The still-trashed task was re-homed to the top of the Inbox before its group went.
    const inbox = await inboxOf(a);
    const p = ctx.db.orm.select().from(placement).where(eq(placement.taskId, keep2.id)).get();
    expect(p?.groupId).toBe(inbox.id);
    await a.ok('POST', `/api/v1/tasks/${keep2.id}/restore`);
    expect(await titlesIn(a, inbox.id)).toEqual(['keep 2', 'keep 1', 'inbox']);
    // Idempotent.
    expect(ctx.app.services.retention.purge()).toMatchObject({ tasks: 0, groups: 0 });
  });

  it('purges expired better-auth verification rows and keeps live ones', () => {
    const now = Date.now();
    const ctx = listCtx({ clock: () => now });
    const row = (id: string, expiresAt: number) => ({
      id,
      identifier: `state-${id}`,
      value: '{}',
      expiresAt: new Date(expiresAt),
      createdAt: new Date(now - DAY),
      updatedAt: new Date(now - DAY),
    });
    ctx.db.orm
      .insert(verification)
      .values([row('old', now - 60_000), row('live', now + 60_000)])
      .run();
    expect(ctx.app.services.retention.purge().verifications).toBe(1);
    expect(ctx.db.orm.select({ id: verification.id }).from(verification).all()).toEqual([
      { id: 'live' },
    ]);
    expect(ctx.app.services.retention.purge().verifications).toBe(0);
  });

  it('purges idempotency rows older than 7 days', async () => {
    let now = Date.now();
    const ctx = listCtx({ clock: () => now });
    const a = ctx.user('a@example.com');
    await a.ok('POST', '/api/v1/orgs/personal/tasks', { title: 'x' }, 201, {
      'Idempotency-Key': 'k-1',
    });
    now += 6 * DAY;
    await a.ok('POST', '/api/v1/orgs/personal/tasks', { title: 'y' }, 201, {
      'Idempotency-Key': 'k-2',
    });
    now += 2 * DAY;
    expect(ctx.app.services.retention.purge().idempotency).toBe(1);
    const left = ctx.db.orm.select({ opId: idempotency.opId }).from(idempotency).all();
    expect(left).toEqual([{ opId: 'k-2' }]);
  });

  it('the scheduler registers purge and backup jobs (backup unless "off")', async () => {
    const ctx = listCtx();
    const scheduler = createScheduler(captureLogger().logger);
    registerJobs(scheduler, {
      db: ctx.db,
      services: ctx.app.services,
      config: testConfig({ ROOSTER_BACKUP_CRON: '0 3 * * *' }),
    });
    expect(scheduler.jobs()).toEqual([
      'pragma-optimize',
      'purge',
      'due-reminders',
      'email-digest',
      'email-batch',
      'task-reminders',
      'blob-gc',
      'backup',
    ]);
    await scheduler.run('purge');
    scheduler.stop();
    const off = createScheduler(captureLogger().logger);
    registerJobs(off, {
      db: ctx.db,
      services: ctx.app.services,
      config: testConfig({ ROOSTER_BACKUP_CRON: 'off' }),
    });
    expect(off.jobs()).toEqual([
      'pragma-optimize',
      'purge',
      'due-reminders',
      'email-digest',
      'email-batch',
      'task-reminders',
      'blob-gc',
    ]);
    off.stop();
  });
});

describe('placement invariant on member removal (05 §4.2)', () => {
  it('unassigns the leaver’s tasks, drops their placements and groups; others are untouched', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const b = ctx.user('b@example.com');
    const org = await sharedOrg(a, [b]);
    const bPrio = await groupNamed(b, 'Prio', org.id);
    const open = await createTask(b, { title: 'open', groupId: bPrio.id }, org.id);
    const done = await createTask(b, { title: 'done' }, org.id);
    const gone = await createTask(b, { title: 'trashed' }, org.id);
    await b.ok('POST', `/api/v1/tasks/${done.id}/complete`, { completed: true });
    await b.ok('DELETE', `/api/v1/tasks/${gone.id}`, undefined, 204);
    const aTask = await createTask(a, { title: 'a keeps' }, org.id);

    await b.ok('DELETE', `/api/v1/orgs/${org.id}/members/${b.userId}`, undefined, 204);

    const rows = ctx.db.orm.select().from(task).where(eq(task.orgId, org.id)).all();
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const t of [open, done, gone]) expect(byId.get(t.id)?.assigneeId).toBeNull();
    const placements = ctx.db.orm.select().from(placement).where(eq(placement.orgId, org.id)).all();
    expect(placements.map((p) => p.taskId)).toEqual([aTask.id]);
    const groups = ctx.db.orm
      .select()
      .from(taskGroup)
      .where(eq(taskGroup.userId, b.userId))
      .all()
      .filter((g) => g.orgId === org.id);
    expect(groups).toEqual([]);
    // The tasks stay visible to the org (no longer in anyone's list).
    const patched = await a.ok<{ task: Task }>('PATCH', `/api/v1/tasks/${open.id}`, {
      title: 'still here',
    });
    expect(patched.task).toMatchObject({ assigneeId: null, placement: null });
    expect((await myList(a, org.id)).tasks.map((t) => t.title)).toEqual(['a keeps']);
  });

  it('reconcilePlacements inserts, keeps and moves placements per the invariant', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const b = ctx.user('b@example.com');
    const org = await sharedOrg(a, [b]);
    const t = await createTask(a, { title: 'x' }, org.id);
    const { placements } = ctx.app.services;
    const reconcile = () =>
      ctx.db.orm.transaction((tx) => placements.reconcilePlacements(tx, [t.id]));
    const placementOf = () =>
      ctx.db.orm.select().from(placement).where(eq(placement.taskId, t.id)).get();

    const before = placementOf();
    reconcile();
    expect(placementOf()).toEqual(before);

    // Assignee changed: the new assignee gets it at the top of their Inbox.
    ctx.db.orm.update(task).set({ assigneeId: b.userId }).where(eq(task.id, t.id)).run();
    reconcile();
    expect(placementOf()).toMatchObject({
      userId: b.userId,
      groupId: (await inboxOf(b, org.id)).id,
    });

    // Unassigned: no placement.
    ctx.db.orm.update(task).set({ assigneeId: null }).where(eq(task.id, t.id)).run();
    reconcile();
    expect(placementOf()).toBeUndefined();

    // Assigned again with no placement: inserted at the top of the Inbox.
    ctx.db.orm.update(task).set({ assigneeId: a.userId }).where(eq(task.id, t.id)).run();
    reconcile();
    expect(placementOf()).toMatchObject({
      userId: a.userId,
      groupId: (await inboxOf(a, org.id)).id,
    });

    // A subtask with the same assignee as its parent has no placement of its own.
    const sub = await createTask(a, { title: 'sub' }, org.id);
    ctx.db.orm
      .update(task)
      .set({ parentId: t.id, subtaskPosition: 'a0' })
      .where(eq(task.id, sub.id))
      .run();
    ctx.db.orm.transaction((tx) => placements.reconcilePlacements(tx, [t.id]));
    expect(
      ctx.db.orm.select().from(placement).where(eq(placement.taskId, sub.id)).get(),
    ).toBeUndefined();
  });
});
