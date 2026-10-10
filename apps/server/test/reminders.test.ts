// Phase 10 (WP 10.4, ADR 0049 §2): task reminders through the API and the `task-reminders`
// job. Push and SMTP are fakes; the clock is injected and moved by hand.

import type {
  NotificationPage,
  PushSubscriptionInfo,
  Reminder,
  Task,
  TaskCompleteResult,
  TaskDetail,
  TaskPage,
  TaskPatchResult,
} from '@rooster/core/schemas';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { taskReminder } from '../src/db/schema/index.ts';
import type { DomainEvent } from '../src/events/bus.ts';
import { registerJobs } from '../src/jobs/register.ts';
import { createScheduler } from '../src/jobs/scheduler.ts';
import { SMTP_ENV, subscriptionBody } from './delivery-fakes.ts';
import { captureLogger, createTestApp } from './helpers.ts';
import { type Caller, createTask, type ListCtx, listCtx, sharedOrg } from './list-helpers.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const STOCKHOLM = 'Europe/Stockholm';

/** Fri 2026-10-09 14:00 in Stockholm (CEST, UTC+2) is 12:00Z; "1 h before" is 11:00Z. */
const DUE = Date.UTC(2026, 9, 9, 12, 0);
const FIRE = DUE - HOUR;
/** Thu 2026-10-08 10:00 local. */
const THURSDAY = Date.UTC(2026, 9, 8, 8, 0);

function manualClock(start: number) {
  let now = start;
  return {
    clock: () => now++,
    set: (at: number) => {
      now = at;
    },
  };
}

async function setup(options: { env?: Record<string, string> } = {}) {
  const time = manualClock(THURSDAY);
  const ctx = listCtx({
    clock: time.clock,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const a = ctx.user('ann@example.com', 'Ann');
  await a.ok('PATCH', '/api/v1/me', { timezone: STOCKHOLM });
  return { ctx, time, a };
}

const fridayTwo = {
  dueDate: '2026-10-09',
  dueTime: '14:00',
  dueTz: STOCKHOLM,
};

const detail = (c: Caller, id: string) => c.ok<TaskDetail>('GET', `/api/v1/tasks/${id}`);
const inbox = (c: Caller) => c.ok<NotificationPage>('GET', '/api/v1/notifications');
const subscribe = (c: Caller, id: string) =>
  c.ok<PushSubscriptionInfo>('POST', '/api/v1/me/push-subscriptions', subscriptionBody(id), 201);
const addReminder = (c: Caller, taskId: string, body: Record<string, unknown>, status = 201) =>
  c.ok<Reminder>('POST', `/api/v1/tasks/${taskId}/reminders`, body, status);

async function fire(ctx: Pick<ListCtx, 'app'>): Promise<number> {
  const n = await ctx.app.services.reminders.runDue();
  await ctx.app.services.deliveries.idle();
  return n;
}

const reminderNotifications = async (c: Caller) =>
  (await inbox(c)).items.filter((n) => n.type === 'reminder');

describe('AC-10.4 task reminders', () => {
  it('AC-10.4 a Fri 14:00 Stockholm task with "1 h before" reminds exactly once at 13:00 local, also when a new instance takes over at 12:59:30', async () => {
    const { ctx, time, a } = await setup();
    await subscribe(a, 'ann-phone');
    const task = await createTask(a, {
      title: 'Call Bob',
      ...fridayTwo,
      reminders: [{ offsetMinutes: 60 }],
    });
    // The row shows the bell until the reminder fires.
    expect(task.nextReminderAt).toBe(FIRE);

    time.set(FIRE - 30_000); // 12:59:30 local
    expect(await fire(ctx)).toBe(0);
    // A new app instance (a container restart) on the same database takes over.
    const second = createTestApp({ db: ctx.db, clock: time.clock, push: ctx.push });
    expect(await fire(second)).toBe(0);

    time.set(FIRE);
    expect(await fire(second)).toBe(1);
    // The old instance's overlapping run, and every later run, find nothing to send.
    expect(await fire(ctx)).toBe(0);
    time.set(FIRE + 5 * MIN);
    expect(await fire(second)).toBe(0);
    expect(await fire(ctx)).toBe(0);

    const items = await reminderNotifications(a);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: 'reminder',
      actor: null,
      task: { id: task.id, title: 'Call Bob' },
      data: { fireAt: FIRE, late: false, to: { dueTime: '14:00' } },
    });
    const pushes = ctx.push.sent.filter((p) => p.payload.tag === `reminder:${task.id}`);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.payload.title).toBe('Call Bob');
    expect(pushes[0]?.payload.url).toMatch(new RegExp(`/t/${task.id}$`));
    expect(pushes[0]?.payload.body).toMatch(/14:00/);

    // No bell once it fired; the detail still lists it, fired.
    const d = await detail(a, task.id);
    expect(d.nextReminderAt).toBeNull();
    expect(d.reminders?.[0]).toMatchObject({ offsetMinutes: 60, fireAt: FIRE });
    expect(d.reminders?.[0]?.firedAt).not.toBeNull();
  });

  it('AC-10.4 moving the due time to 15:00 moves the reminder to 14:00', async () => {
    const { a } = await setup();
    const task = await createTask(a, {
      title: 'Call Bob',
      ...fridayTwo,
      reminders: [{ offsetMinutes: 60 }],
    });
    const moved = await a.ok<TaskPatchResult>('PATCH', `/api/v1/tasks/${task.id}`, {
      ...fridayTwo,
      dueTime: '15:00',
    });
    expect(moved.task.nextReminderAt).toBe(FIRE + HOUR);
    expect((await detail(a, task.id)).reminders?.[0]?.fireAt).toBe(FIRE + HOUR);
  });

  it('AC-10.4 a task completed before 13:00 does not remind', async () => {
    const { ctx, time, a } = await setup();
    await subscribe(a, 'ann-phone');
    const task = await createTask(a, {
      title: 'Call Bob',
      ...fridayTwo,
      reminders: [{ offsetMinutes: 60 }],
    });
    time.set(FIRE - 30 * MIN);
    const done = await a.ok<TaskCompleteResult>('POST', `/api/v1/tasks/${task.id}/complete`, {
      completed: true,
    });
    // A done task shows no bell.
    expect(done.task.nextReminderAt).toBeNull();
    time.set(FIRE);
    expect(await fire(ctx)).toBe(0);
    expect(await reminderNotifications(a)).toEqual([]);
    expect(ctx.push.sent).toEqual([]);
  });

  it('AC-10.4 `Call Bob fri 14:00 !1h` with parse: true creates the same task and reminder', async () => {
    const { a } = await setup();
    const task = await createTask(a, { title: 'Call Bob fri 14:00 !1h', parse: true });
    expect(task).toMatchObject({
      title: 'Call Bob',
      ...fridayTwo,
      nextReminderAt: FIRE,
    });
    expect((await detail(a, task.id)).reminders).toEqual([
      expect.objectContaining({ kind: 'relative', offsetMinutes: 60, fireAt: FIRE }),
    ]);
  });

  it('AC-10.4 another member of the org sees neither the bell nor the reminder', async () => {
    const time = manualClock(THURSDAY);
    const ctx = listCtx({ clock: time.clock });
    const a = ctx.user('ann@example.com', 'Ann');
    const b = ctx.user('bo@example.com', 'Bo');
    const org = await sharedOrg(a, [b]);
    const events: DomainEvent[] = [];
    ctx.app.services.events.on((e) => events.push(e));
    const task = await createTask(a, { title: 'Call Bob', ...fridayTwo }, org.id);
    events.length = 0;
    const reminder = await addReminder(a, task.id, { offsetMinutes: 60 });

    // Only Ann's streams hear about it.
    const reached = new Set(events.flatMap((e) => e.audiences.flatMap((x) => x.userIds)));
    expect([...reached]).toEqual([a.userId]);

    const seen = await detail(b, task.id);
    expect(seen.nextReminderAt).toBeNull();
    expect(seen.reminders).toEqual([]);
    expect(await b.ok<Reminder[]>('GET', `/api/v1/tasks/${task.id}/reminders`)).toEqual([]);
    const everyone = await b.ok<TaskPage>('GET', `/api/v1/orgs/${org.id}/tasks?view=everyone`);
    expect(everyone.items.find((t) => t.id === task.id)?.nextReminderAt).toBeNull();
    // Nor can Bo remove it.
    const res = await b.call('DELETE', `/api/v1/tasks/${task.id}/reminders/${reminder.id}`);
    expect(res.status).toBe(404);
    // Ann sees hers.
    const mine = await a.ok<TaskPage>('GET', `/api/v1/orgs/${org.id}/tasks?view=everyone`);
    expect(mine.items.find((t) => t.id === task.id)?.nextReminderAt).toBe(FIRE);

    // When it fires, only Ann is notified.
    time.set(FIRE);
    expect(await fire(ctx)).toBe(1);
    expect(await reminderNotifications(a)).toHaveLength(1);
    expect(await reminderNotifications(b)).toEqual([]);
  });

  it('AC-10.4 completing a weekly recurring task gives the next instance the same reminder', async () => {
    const { a } = await setup();
    const task = await createTask(a, {
      title: 'Weekly sync',
      ...fridayTwo,
      recurrence: 'FREQ=WEEKLY',
      reminders: [{ offsetMinutes: 60 }, { at: FIRE - 2 * HOUR }],
    });
    const { next } = await a.ok<TaskCompleteResult>('POST', `/api/v1/tasks/${task.id}/complete`, {
      completed: true,
    });
    const week = 7 * 24 * HOUR;
    expect(next).toMatchObject({ dueDate: '2026-10-16', nextReminderAt: FIRE + week });
    // Relative reminders carry over; absolute ones stay behind (FR-REM-5).
    expect((await detail(a, next?.id ?? '')).reminders).toEqual([
      expect.objectContaining({ kind: 'relative', offsetMinutes: 60, fireAt: FIRE + week }),
    ]);
  });
});

describe('reminders: firing rules (ADR 0049 §2.3)', () => {
  it('fires late within 24 hours (marked late) and drops a reminder more than a day late', async () => {
    const { ctx, time, a } = await setup();
    const late = await createTask(a, {
      title: 'Late',
      ...fridayTwo,
      reminders: [{ offsetMinutes: 60 }],
    });
    const dropped = await createTask(a, {
      title: 'Dropped',
      dueDate: '2026-10-08',
      dueTime: '12:00',
      dueTz: STOCKHOLM,
      reminders: [{ offsetMinutes: 0 }],
    });
    // The server was down from Thursday until Friday 13:30 local.
    time.set(FIRE + 30 * MIN);
    expect(await fire(ctx)).toBe(1);
    const items = await reminderNotifications(a);
    expect(items.map((n) => [n.task?.id, n.data.late])).toEqual([[late.id, true]]);
    const row = ctx.db.orm
      .select()
      .from(taskReminder)
      .where(eq(taskReminder.taskId, dropped.id))
      .get();
    expect(row?.firedAt).not.toBeNull();
  });

  it('the job is registered and runs once at boot', async () => {
    const { ctx, time, a } = await setup();
    await createTask(a, { title: 'Missed', ...fridayTwo, reminders: [{ offsetMinutes: 60 }] });
    time.set(FIRE + 2 * MIN);
    const scheduler = createScheduler(captureLogger().logger);
    try {
      registerJobs(scheduler, { db: ctx.db, services: ctx.app.services });
      expect(scheduler.jobs()).toContain('task-reminders');
      await new Promise((resolve) => setTimeout(resolve, 10));
      await ctx.app.services.deliveries.idle();
      expect(await reminderNotifications(a)).toHaveLength(1);
    } finally {
      scheduler.stop();
    }
  });

  it('emails a reminder at once, also in batch mode, when the user turned email on', async () => {
    const { ctx, time, a } = await setup({ env: SMTP_ENV });
    await a.ok('PUT', '/api/v1/me/notification-prefs', {
      prefs: [{ type: 'reminder', channel: 'email', enabled: true }],
    });
    await a.ok('PATCH', '/api/v1/me', { prefs: { emailMode: 'batch' } });
    await createTask(a, { title: 'Call Bob', ...fridayTwo, reminders: [{ offsetMinutes: 60 }] });
    time.set(FIRE);
    expect(await fire(ctx)).toBe(1);
    const mails = ctx.mail.to('ann@example.com');
    expect(mails.map((m) => m.subject)).toEqual(['Reminder: Call Bob']);
    expect(mails[0]?.text).toMatch(/14:00/);
    expect(mails[0]?.headers['List-Unsubscribe']).toMatch(/\/unsubscribe\//);
  });

  it('follows the "Task reminders" preference row: in-app off still pushes', async () => {
    const { ctx, time, a } = await setup();
    await subscribe(a, 'ann-phone');
    await a.ok('PUT', '/api/v1/me/notification-prefs', {
      prefs: [{ type: 'reminder', channel: 'inapp', enabled: false }],
    });
    const task = await createTask(a, {
      title: 'Call Bob',
      ...fridayTwo,
      reminders: [{ offsetMinutes: 60 }],
    });
    time.set(FIRE);
    await fire(ctx);
    expect(await reminderNotifications(a)).toEqual([]);
    expect(ctx.push.sent.map((p) => p.payload.tag)).toEqual([`reminder:${task.id}`]);
  });
});

describe('reminders: dormant, revived and re-resolved (ADR 0049 §2.1–2.2)', () => {
  it('clearing the due date makes relative reminders dormant; a due date revives them', async () => {
    const { a } = await setup();
    const task = await createTask(a, {
      title: 'Call Bob',
      ...fridayTwo,
      reminders: [{ offsetMinutes: 60 }, { at: FIRE + 3 * HOUR }],
    });
    const cleared = await a.ok<TaskPatchResult>('PATCH', `/api/v1/tasks/${task.id}`, {
      dueDate: null,
    });
    expect(cleared.task.nextReminderAt).toBe(FIRE + 3 * HOUR);
    const dormant = (await detail(a, task.id)).reminders ?? [];
    // Pending first, dormant last.
    expect(dormant.map((r) => [r.kind, r.fireAt])).toEqual([
      ['absolute', FIRE + 3 * HOUR],
      ['relative', null],
    ]);
    const revived = await a.ok<TaskPatchResult>('PATCH', `/api/v1/tasks/${task.id}`, fridayTwo);
    expect(revived.task.nextReminderAt).toBe(FIRE);
  });

  it('an all-day task reminds at the owner’s allDayReminderTime in their timezone', async () => {
    const { a } = await setup();
    const task = await createTask(a, {
      title: 'Pay rent',
      dueDate: '2026-10-09',
      reminders: [{ offsetMinutes: 0 }],
    });
    expect(task.nextReminderAt).toBe(Date.UTC(2026, 9, 9, 7, 0)); // 09:00 CEST
    await a.ok('PATCH', '/api/v1/me', { prefs: { allDayReminderTime: '07:30' } });
    expect((await detail(a, task.id)).nextReminderAt).toBe(Date.UTC(2026, 9, 9, 5, 30));
    await a.ok('PATCH', '/api/v1/me', { timezone: 'UTC' });
    expect((await detail(a, task.id)).nextReminderAt).toBe(Date.UTC(2026, 9, 9, 7, 30));
  });

  it('postponing after it fired reminds again', async () => {
    const { ctx, time, a } = await setup();
    const task = await createTask(a, {
      title: 'Call Bob',
      ...fridayTwo,
      reminders: [{ offsetMinutes: 60 }],
    });
    time.set(FIRE);
    expect(await fire(ctx)).toBe(1);
    const moved = await a.ok<TaskPatchResult>('PATCH', `/api/v1/tasks/${task.id}`, {
      ...fridayTwo,
      dueDate: '2026-10-12',
    });
    expect(moved.task.nextReminderAt).toBe(Date.UTC(2026, 9, 12, 11, 0));
  });
});

describe('reminders: create, limits and removal (ADR 0049 §2.5)', () => {
  it('returns an identical reminder instead of a duplicate, and replays a client id', async () => {
    const { a } = await setup();
    const task = await createTask(a, { title: 'Call Bob', ...fridayTwo });
    const first = await addReminder(a, task.id, { offsetMinutes: 15 });
    const again = await addReminder(a, task.id, { offsetMinutes: 15 }, 200);
    expect(again.id).toBe(first.id);
    const id = '0199c5a2-c6d7-75e8-b9fa-6a7b8c9d0e77';
    const created = await addReminder(a, task.id, { id, at: FIRE + HOUR });
    expect(created.id).toBe(id);
    expect((await addReminder(a, task.id, { id, at: FIRE + HOUR }, 200)).id).toBe(id);
    const conflict = await a.call('POST', `/api/v1/tasks/${task.id}/reminders`, {
      id,
      offsetMinutes: 30,
    });
    expect(conflict.status).toBe(409);
  });

  it('enforces the limit, a due date for relative ones and no past instants', async () => {
    const { a } = await setup();
    const task = await createTask(a, { title: 'Call Bob', ...fridayTwo });
    for (const m of [0, 5, 10, 15, 30]) await addReminder(a, task.id, { offsetMinutes: m });
    const sixth = await a.call('POST', `/api/v1/tasks/${task.id}/reminders`, { offsetMinutes: 60 });
    expect(sixth.status).toBe(409);
    expect(((await sixth.json()) as { code: string }).code).toBe('too_many_reminders');

    const undated = await createTask(a, { title: 'Someday' });
    const needsDue = await a.call('POST', `/api/v1/tasks/${undated.id}/reminders`, {
      offsetMinutes: 60,
    });
    expect(((await needsDue.json()) as { code: string }).code).toBe('reminder_needs_due');
    const past = await a.call('POST', `/api/v1/tasks/${undated.id}/reminders`, {
      at: THURSDAY - 2 * MIN,
    });
    expect(past.status).toBe(422);
    expect(((await past.json()) as { code: string }).code).toBe('reminder_in_past');
    // Create rolls back with an invalid reminder.
    const res = await a.call('POST', '/api/v1/orgs/personal/tasks', {
      title: 'No date',
      reminders: [{ offsetMinutes: 5 }],
    });
    expect(((await res.json()) as { code: string }).code).toBe('reminder_needs_due');
  });

  it('PATCH clearReminders and reminders replace the actor’s reminders; DELETE removes one', async () => {
    const { a } = await setup();
    const task = await createTask(a, {
      title: 'Call Bob',
      ...fridayTwo,
      reminders: [{ offsetMinutes: 60 }, { offsetMinutes: 15 }],
    });
    const patched = await a.ok<TaskPatchResult>('PATCH', `/api/v1/tasks/${task.id}`, {
      clearReminders: true,
      reminders: [{ offsetMinutes: 1440 }],
    });
    expect(patched.task.nextReminderAt).toBe(DUE - 24 * HOUR);
    const [only] = (await detail(a, task.id)).reminders ?? [];
    expect(only?.offsetMinutes).toBe(1440);
    await a.ok('DELETE', `/api/v1/tasks/${task.id}/reminders/${only?.id}`, undefined, 204);
    expect((await detail(a, task.id)).reminders).toEqual([]);
    expect((await a.call('DELETE', `/api/v1/tasks/${task.id}/reminders/${only?.id}`)).status).toBe(
      404,
    );
  });

  it('a deleted task takes no new reminders (410)', async () => {
    const { a } = await setup();
    const task = await createTask(a, { title: 'Gone', ...fridayTwo });
    await a.ok('DELETE', `/api/v1/tasks/${task.id}`, undefined, 204);
    const res = await a.call('POST', `/api/v1/tasks/${task.id}/reminders`, { offsetMinutes: 5 });
    expect(res.status).toBe(410);
  });

  it('removing a member deletes their reminders on that org’s tasks', async () => {
    const time = manualClock(THURSDAY);
    const ctx = listCtx({ clock: time.clock });
    const a = ctx.user('ann@example.com', 'Ann');
    const b = ctx.user('bo@example.com', 'Bo');
    const org = await sharedOrg(a, [b]);
    const task: Task = await createTask(a, { title: 'Call Bob', ...fridayTwo }, org.id);
    await addReminder(b, task.id, { offsetMinutes: 60 });
    await addReminder(a, task.id, { offsetMinutes: 30 });
    await a.ok('DELETE', `/api/v1/orgs/${org.id}/members/${b.userId}`, undefined, 204);
    const left = ctx.db.orm.select().from(taskReminder).all();
    expect(left.map((r) => r.userId)).toEqual([a.userId]);
  });
});
