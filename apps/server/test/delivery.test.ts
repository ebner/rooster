// Phase 7 (WP 7.1–7.4, server side): Web Push, email, the delivery jobs and the preference
// matrix. Push services and SMTP are fakes (delivery-fakes.ts); clocks are injected.

import { uuidv7 } from '@rooster/core/ids';
import type {
  InviteCreated,
  Meta,
  NotificationPage,
  NotificationPrefs,
  Problem,
  PushSubscriptionInfo,
  VapidPublicKey,
} from '@rooster/core/schemas';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  instanceSetting,
  jobRun,
  member,
  notification,
  pushSubscription,
} from '../src/db/schema/index.ts';
import { unsubscribeToken } from '../src/mail/unsubscribe-token.ts';
import { dueSlot, SEND_GRACE_MS } from '../src/services/job-runs.ts';
import { FakeMail, FakePush, fcmEndpoint, SMTP_ENV, subscriptionBody } from './delivery-fakes.ts';
import { createTestApp, TEST_ENV } from './helpers.ts';
import {
  type Caller,
  createTask,
  groupNamed,
  type ListCtx,
  listCtx,
  sharedOrg,
} from './list-helpers.ts';

const MIN = 60_000;
const STOCKHOLM = 'Europe/Stockholm';

/** A clock the test moves by hand; every read ticks 1 ms so LWW stamps stay ordered. */
function manualClock(start: number) {
  let now = start;
  return {
    clock: () => now++,
    set: (at: number) => {
      now = at;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const prefs = (c: Caller) => c.ok<NotificationPrefs>('GET', '/api/v1/me/notification-prefs');
const setCells = (c: Caller, cells: { type: string; channel: string; enabled: boolean }[]) =>
  c.ok<NotificationPrefs>('PUT', '/api/v1/me/notification-prefs', { prefs: cells });
const subscribe = (c: Caller, id: string) =>
  c.ok<PushSubscriptionInfo>('POST', '/api/v1/me/push-subscriptions', subscriptionBody(id), 201);
const inbox = (c: Caller) => c.ok<NotificationPage>('GET', '/api/v1/notifications');

/** Ann owns a shared org with member Bo. */
async function pair(ctx: ListCtx) {
  const a = ctx.user('ann@example.com', 'Ann Andersson');
  const b = ctx.user('bo@example.com', 'Bo Berg');
  const org = await sharedOrg(a, [b], 'Acme');
  ctx.db.orm.delete(notification).run();
  ctx.mail.clear();
  return { a, b, org };
}

async function idle(ctx: { app: ListCtx['app'] }): Promise<void> {
  await ctx.app.services.deliveries.idle();
}

// ---------------------------------------------------------------------------------------------
// The grace window and DST (WP 7.3)
// ---------------------------------------------------------------------------------------------

describe('dueSlot: user-local send times with a grace window', () => {
  it('is due from the local time until the grace window ends', () => {
    const at = Date.UTC(2026, 9, 15, 6, 0); // 08:00 CEST
    expect(dueSlot(at - 1, STOCKHOLM, '08:00')).toBeNull();
    expect(dueSlot(at, STOCKHOLM, '08:00')).toEqual({ date: '2026-10-15', at });
    expect(dueSlot(at + SEND_GRACE_MS - 1, STOCKHOLM, '08:00')?.date).toBe('2026-10-15');
    expect(dueSlot(at + SEND_GRACE_MS, STOCKHOLM, '08:00')).toBeNull();
  });

  it('counts a send time just before midnight for the day it belongs to', () => {
    const after = Date.UTC(2026, 9, 15, 22, 2); // 00:02 CEST on the 16th
    expect(dueSlot(after, STOCKHOLM, '23:55')?.date).toBe('2026-10-15');
  });

  it('DST: a skipped time fires after the jump, a repeated one at its first occurrence', () => {
    // 2026-03-29: 02:00 → 03:00 in Stockholm. 02:30 does not exist; it fires at 03:30 CEST.
    expect(dueSlot(Date.UTC(2026, 2, 29, 1, 29), STOCKHOLM, '02:30')).toBeNull();
    expect(dueSlot(Date.UTC(2026, 2, 29, 1, 30), STOCKHOLM, '02:30')?.date).toBe('2026-03-29');
    // 2026-10-25: 03:00 → 02:00. 02:30 happens twice; only the first (00:30Z) is due.
    expect(dueSlot(Date.UTC(2026, 9, 25, 0, 30), STOCKHOLM, '02:30')?.date).toBe('2026-10-25');
    expect(dueSlot(Date.UTC(2026, 9, 25, 1, 30), STOCKHOLM, '02:30')).toBeNull();
    // 08:00 on the switch day is 07:00Z (CET), not 06:00Z.
    expect(dueSlot(Date.UTC(2026, 9, 25, 6, 0), STOCKHOLM, '08:00')).toBeNull();
    expect(dueSlot(Date.UTC(2026, 9, 25, 7, 0), STOCKHOLM, '08:00')?.date).toBe('2026-10-25');
  });
});

// ---------------------------------------------------------------------------------------------
// AC-7.1: the due reminder
// ---------------------------------------------------------------------------------------------

describe('due reminder (FR-NOT-2, WP 7.3)', () => {
  const day = '2026-10-15';
  const at = (h: number, m: number, s = 0) => Date.UTC(2026, 9, 15, h - 2, m, s); // CEST

  async function reminderUser(start: number) {
    const time = manualClock(start);
    const ctx = listCtx({ clock: time.clock });
    const u = ctx.user('ann@example.com', 'Ann Andersson');
    await u.ok('PATCH', '/api/v1/me', { timezone: STOCKHOLM, prefs: { reminderTime: '08:00' } });
    await setCells(u, [{ type: 'due_reminder', channel: 'push', enabled: true }]);
    await subscribe(u, 'phone');
    return { ...ctx, u, time };
  }

  it('AC-7.1 exactly one push at 08:00 Europe/Stockholm, across a restart at 07:59:30', async () => {
    const { app, db, push, u, time } = await reminderUser(at(7, 0));
    for (const title of ['Pay rent', 'Call Bo', 'Book flights']) {
      await createTask(u, { title, dueDate: day });
    }
    await createTask(u, { title: 'Tomorrow', dueDate: '2026-10-16' });

    time.set(at(7, 59));
    expect(await app.services.push.runDueReminders()).toBe(0);

    // The container restarts at 07:59:30: a fresh app and services over the same database.
    time.set(at(7, 59, 30));
    const restarted = createTestApp({ db, clock: time.clock, push });
    const run = () => restarted.app.services.push.runDueReminders();

    time.set(at(8, 0));
    expect(await run()).toBe(1);
    time.set(at(8, 0, 30));
    expect(await run()).toBe(0);
    time.set(at(8, 1));
    expect(await run()).toBe(0);
    // The old instance (still running in a rolling restart) cannot send it again either.
    expect(await app.services.push.runDueReminders()).toBe(0);

    expect(push.sent).toHaveLength(1);
    const [sent] = push.sent;
    expect(sent?.endpoint).toBe(fcmEndpoint('phone'));
    expect(sent?.payload).toMatchObject({
      kind: 'due_reminder',
      title: '3 tasks today',
      body: 'Pay rent\nCall Bo\nBook flights',
      tag: 'due_reminder',
    });
    expect(sent?.payload.url).toMatch(/^\/o\/[^/]+\/today$/);
    expect(sent?.options).toMatchObject({ urgency: 'high', ttl: 4 * 3600 });
    expect(db.orm.select().from(jobRun).all()).toEqual([
      { job: 'due_reminder', scope: `${u.userId}|${day}`, ranAt: expect.any(Number) },
    ]);
  });

  it('a restart that misses 08:00 still sends within the grace window, not after it', async () => {
    const { app, push, u, time } = await reminderUser(at(7, 0));
    await createTask(u, { title: 'Due', dueDate: day });
    time.set(at(8, 9));
    expect(await app.services.push.runDueReminders()).toBe(1);
    expect(push.sent).toHaveLength(1);

    const late = await reminderUser(at(7, 0));
    await createTask(late.u, { title: 'Due', dueDate: day });
    late.time.set(at(8, 0) + SEND_GRACE_MS);
    expect(await late.app.services.push.runDueReminders()).toBe(0);
  });

  it('lists overdue tasks too, says how many more, and skips a day with nothing due', async () => {
    const { app, push, u, time } = await reminderUser(at(7, 0));
    await createTask(u, { title: 'Late', dueDate: '2026-10-10' });
    for (const title of ['A', 'B', 'C', 'D']) await createTask(u, { title, dueDate: day });
    const done = await createTask(u, { title: 'Done', dueDate: day });
    await u.ok('POST', `/api/v1/tasks/${done.id}/complete`, { completed: true });
    time.set(at(8, 0));
    await app.services.push.runDueReminders();
    expect(push.sent[0]?.payload).toMatchObject({
      title: '5 tasks today',
      body: 'Late\nA\nB\nand 2 more',
    });

    const empty = await reminderUser(at(7, 0));
    empty.time.set(at(8, 0));
    expect(await empty.app.services.push.runDueReminders()).toBe(0);
    expect(empty.push.sent).toEqual([]);
  });

  it('is off by default, needs a device, and is written in the user’s language', async () => {
    const time = manualClock(at(7, 0));
    const ctx = listCtx({ clock: time.clock });
    const off = ctx.user('off@example.com');
    await off.ok('PATCH', '/api/v1/me', { timezone: STOCKHOLM });
    await subscribe(off, 'off');
    await createTask(off, { title: 'X', dueDate: day });
    const noDevice = ctx.user('nodevice@example.com');
    await noDevice.ok('PATCH', '/api/v1/me', { timezone: STOCKHOLM });
    await setCells(noDevice, [{ type: 'due_reminder', channel: 'push', enabled: true }]);
    await createTask(noDevice, { title: 'Y', dueDate: day });
    const sv = ctx.user('sv@example.com');
    await sv.ok('PATCH', '/api/v1/me', { timezone: STOCKHOLM, locale: 'sv' });
    await setCells(sv, [{ type: 'due_reminder', channel: 'push', enabled: true }]);
    await subscribe(sv, 'sv');
    await createTask(sv, { title: 'Z', dueDate: day });
    time.set(at(8, 0));
    expect(await ctx.app.services.push.runDueReminders()).toBe(1);
    expect(ctx.push.sent.map((s) => [s.endpoint, s.payload.title])).toEqual([
      [fcmEndpoint('sv'), '1 uppgift idag'],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Web Push: subscriptions, notification pushes, cleanup, test and key rotation (WP 7.1)
// ---------------------------------------------------------------------------------------------

describe('push subscriptions (06 §2.6)', () => {
  it('upserts by endpoint, lists my devices and deletes only my own', async () => {
    const ctx = listCtx();
    const { a, b } = await pair(ctx);
    const first = await subscribe(a, 'shared-laptop');
    expect(first).toMatchObject({ userAgent: 'Firefox on Linux', lastOkAt: null });
    // Bo signs in on the same browser: the subscription moves to him, with new keys.
    const moved = await subscribe(b, 'shared-laptop');
    expect(moved.id).toBe(first.id);
    expect(await a.ok('GET', '/api/v1/me/push-subscriptions')).toEqual([]);
    expect(await b.ok('GET', '/api/v1/me/push-subscriptions')).toEqual([moved]);
    expect((await a.call('DELETE', `/api/v1/me/push-subscriptions/${moved.id}`)).status).toBe(404);
    await b.ok('DELETE', `/api/v1/me/push-subscriptions/${moved.id}`, undefined, 204);
    expect(await b.ok('GET', '/api/v1/me/push-subscriptions')).toEqual([]);
  });

  it('falls back to the User-Agent header for the device label', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const { userAgent: _, ...body } = subscriptionBody('ua');
    const created = await a.ok<PushSubscriptionInfo>(
      'POST',
      '/api/v1/me/push-subscriptions',
      body,
      201,
      { 'user-agent': 'Mozilla/5.0 (X11)' },
    );
    expect(created.userAgent).toBe('Mozilla/5.0 (X11)');
  });

  it('SSRF: endpoints off the known push services are 422, never stored', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    for (const endpoint of [
      'https://127.0.0.1/x',
      'https://intranet.example.com/x',
      'https://fcm.googleapis.com.attacker.example/x',
      'http://fcm.googleapis.com/fcm/send/x',
    ]) {
      const res = await a.call('POST', '/api/v1/me/push-subscriptions', {
        ...subscriptionBody('x'),
        endpoint,
      });
      expect(res.status, endpoint).toBe(422);
      expect(((await res.json()) as Problem).errors?.[0]?.path).toBe('endpoint');
    }
    expect(ctx.db.orm.select().from(pushSubscription).all()).toEqual([]);
  });

  it('serves the VAPID public key, generated once and kept in instance_setting', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const { publicKey } = await a.ok<VapidPublicKey>('GET', '/api/v1/push/vapid-public-key');
    expect(Buffer.from(publicKey, 'base64url')).toHaveLength(65);
    const stored = ctx.db.orm.select().from(instanceSetting).all();
    expect(stored.find((s) => s.key === 'vapid_public')?.value).toBe(publicKey);
    // Another instance over the same database uses the same keys.
    const again = createTestApp({ db: ctx.db });
    expect(again.app.services.push.publicKey().publicKey).toBe(publicKey);
  });

  it('uses keys from the environment when they are set', async () => {
    const keys = {
      ROOSTER_VAPID_PUBLIC:
        'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
      ROOSTER_VAPID_PRIVATE: 'tUxbf-Mx9Ex4QgiRbWvt-Q1j0yAfGfgFFUFvcNt7ZnU',
    };
    const ctx = listCtx({ env: keys });
    const admin = ctx.user(TEST_ENV.ROOSTER_ADMIN_EMAILS);
    expect(await admin.ok('GET', '/api/v1/push/vapid-public-key')).toEqual({
      publicKey: keys.ROOSTER_VAPID_PUBLIC,
    });
    const res = await admin.call('POST', '/api/v1/admin/push-keys/regenerate');
    expect(res.status).toBe(409);
    expect(((await res.json()) as Problem).code).toBe('push_keys_from_env');
  });

  it('admin regenerate replaces the keys and drops every subscription', async () => {
    const ctx = listCtx();
    const admin = ctx.user(TEST_ENV.ROOSTER_ADMIN_EMAILS);
    const a = ctx.user('a@example.com');
    const before = await a.ok<VapidPublicKey>('GET', '/api/v1/push/vapid-public-key');
    await subscribe(a, 'one');
    await subscribe(admin, 'two');
    const after = await admin.ok<VapidPublicKey>('POST', '/api/v1/admin/push-keys/regenerate');
    expect(after.publicKey).not.toBe(before.publicKey);
    expect(await a.ok('GET', '/api/v1/push/vapid-public-key')).toEqual(after);
    expect(ctx.db.orm.select().from(pushSubscription).all()).toEqual([]);
    expect((await a.call('POST', '/api/v1/admin/push-keys/regenerate')).status).toBe(403);
  });

  it('test push: 204 when accepted, 410 and deleted when gone, 502 otherwise', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const ok = await subscribe(a, 'ok');
    await a.ok('POST', `/api/v1/me/push-subscriptions/${ok.id}/test`, undefined, 204);
    expect(ctx.push.sent[0]?.payload).toEqual({
      kind: 'test',
      title: 'Push notifications work',
      body: 'This device will show notifications from rooster.',
      url: '/settings/notifications',
      tag: 'test',
    });
    expect(ctx.push.sent[0]?.options.vapid.subject).toBe('mailto:admin@example.com');
    const [listed] = await a.ok<PushSubscriptionInfo[]>('GET', '/api/v1/me/push-subscriptions');
    expect(listed?.lastOkAt).toEqual(expect.any(Number));

    const gone = await subscribe(a, 'gone');
    ctx.push.failWith.set(fcmEndpoint('gone'), 410);
    const res = await a.call('POST', `/api/v1/me/push-subscriptions/${gone.id}/test`);
    expect(res.status).toBe(410);
    expect(((await res.json()) as Problem).code).toBe('push_gone');
    expect(
      (await a.ok<PushSubscriptionInfo[]>('GET', '/api/v1/me/push-subscriptions')).map((s) => s.id),
    ).toEqual([ok.id]);

    ctx.push.failWith.set(fcmEndpoint('ok'), 500);
    const failed = await a.call('POST', `/api/v1/me/push-subscriptions/${ok.id}/test`);
    expect(failed.status).toBe(502);
    expect(((await failed.json()) as Problem).code).toBe('push_failed');
    expect(await a.ok<PushSubscriptionInfo[]>('GET', '/api/v1/me/push-subscriptions')).toHaveLength(
      1,
    );
  });
});

describe('notification pushes (FR-NOT-2)', () => {
  it('pushes a new notification to every device, localised, after commit', async () => {
    const ctx = listCtx();
    const { a, b, org } = await pair(ctx);
    await subscribe(b, 'phone');
    await subscribe(b, 'laptop');
    const task = await createTask(a, { title: 'Ship it', assigneeId: b.userId }, org.id);
    await idle(ctx);
    expect(ctx.push.sent.map((s) => s.endpoint).sort()).toEqual(
      [fcmEndpoint('laptop'), fcmEndpoint('phone')].sort(),
    );
    expect(ctx.push.sent[0]?.payload).toEqual({
      kind: 'notification',
      title: 'Ann Andersson assigned a task to you',
      body: 'Ship it',
      url: `/o/${org.slug}/t/${task.id}`,
      tag: `task:${task.id}`,
    });
    expect(ctx.push.sent[0]?.options).toMatchObject({ ttl: 24 * 3600, urgency: 'normal' });
    const row = ctx.db.orm.select().from(notification).get();
    expect(row?.pushedAt).toEqual(expect.any(Number));

    // A comment carries its excerpt; Swedish recipients get Swedish.
    ctx.push.clear();
    await b.ok('PATCH', '/api/v1/me', { locale: 'sv' });
    await a.ok('POST', `/api/v1/tasks/${task.id}/comments`, { body: 'Klart snart' }, 201);
    await idle(ctx);
    expect(ctx.push.sent[0]?.payload).toMatchObject({
      title: 'Ann Andersson kommenterade en uppgift du följer',
      body: 'Ship it\n”Klart snart”',
    });
  });

  it('never pushes my own actions, or with the push cell off', async () => {
    const ctx = listCtx();
    const { a, b, org } = await pair(ctx);
    await subscribe(a, 'ann');
    await subscribe(b, 'bo');
    await createTask(a, { title: 'Mine', assigneeId: a.userId }, org.id);
    await setCells(b, [{ type: 'assigned', channel: 'push', enabled: false }]);
    await createTask(a, { title: 'Quiet', assigneeId: b.userId }, org.id);
    await idle(ctx);
    expect(ctx.push.sent).toEqual([]);
    // In-app still has it.
    expect((await inbox(b)).items.map((n) => n.task?.title)).toEqual(['Quiet']);
  });

  it('with in-app off but push on, the row is hidden from the inbox and still pushed', async () => {
    const ctx = listCtx();
    const { a, b, org } = await pair(ctx);
    await subscribe(b, 'bo');
    await setCells(b, [{ type: 'assigned', channel: 'inapp', enabled: false }]);
    await createTask(a, { title: 'Push only', assigneeId: b.userId }, org.id);
    await idle(ctx);
    expect(ctx.push.sent.map((s) => s.payload.body)).toEqual(['Push only']);
    const page = await inbox(b);
    expect(page.items).toEqual([]);
    expect(page.unreadCount).toBe(0);
    expect(await b.ok('POST', '/api/v1/notifications/unread', { all: true })).toEqual({
      unreadCount: 0,
    });
  });

  it('a 404 or 410 deletes the subscription; other failures keep it and never fail the write', async () => {
    const ctx = listCtx();
    const { a, b, org } = await pair(ctx);
    await subscribe(b, 'gone');
    await subscribe(b, 'expired');
    await subscribe(b, 'flaky');
    ctx.push.failWith.set(fcmEndpoint('gone'), 410);
    ctx.push.failWith.set(fcmEndpoint('expired'), 404);
    ctx.push.failWith.set(fcmEndpoint('flaky'), 503);
    await createTask(a, { title: 'Hello', assigneeId: b.userId }, org.id);
    await idle(ctx);
    const left = ctx.db.orm.select().from(pushSubscription).all();
    expect(left.map((s) => s.endpoint)).toEqual([fcmEndpoint('flaky')]);
    expect(ctx.db.orm.select().from(notification).get()?.pushedAt).toBeNull();
  });

  it('SSRF: a stored row with a disallowed endpoint is deleted, never sent to', async () => {
    const ctx = listCtx();
    const { a, b, org } = await pair(ctx);
    ctx.db.orm
      .insert(pushSubscription)
      .values({
        id: uuidv7(),
        userId: b.userId,
        endpoint: 'https://intranet.example.com/admin',
        p256dh: 'x',
        auth: 'y',
        userAgent: null,
        createdAt: 1,
        lastOkAt: null,
      })
      .run();
    await createTask(a, { title: 'Hello', assigneeId: b.userId }, org.id);
    await idle(ctx);
    expect(ctx.push.sent).toEqual([]);
    expect(ctx.db.orm.select().from(pushSubscription).all()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Email: notifications at once or batched (WP 7.2)
// ---------------------------------------------------------------------------------------------

describe('notification emails (FR-NOT-3)', () => {
  async function mailPair() {
    const time = manualClock(Date.UTC(2026, 9, 15, 10));
    const ctx = listCtx({ clock: time.clock, env: SMTP_ENV });
    return { ...ctx, ...(await pair(ctx)), time };
  }

  it('batch (default): one email once the oldest waited 15 minutes, then nothing again', async () => {
    const { app, mail, a, b, org, time, db } = await mailPair();
    await createTask(a, { title: 'First', assigneeId: b.userId }, org.id);
    time.advance(5 * MIN);
    // A mention is on by default too; a comment email is not.
    const t = await createTask(a, { title: 'Second', assigneeId: b.userId }, org.id);
    await a.ok('POST', `/api/v1/tasks/${t.id}/comments`, { body: 'plain comment' }, 201);
    await idle({ app });
    expect(mail.sent).toEqual([]);
    time.advance(9 * MIN);
    expect(await app.services.mail.runBatches()).toBe(0);
    time.advance(2 * MIN);
    expect(await app.services.mail.runBatches()).toBe(1);
    expect(await app.services.mail.runBatches()).toBe(0);
    expect(mail.sent).toHaveLength(1);
    const [email] = mail.sent;
    expect(email).toMatchObject({
      to: 'bo@example.com',
      from: 'rooster <rooster@example.com>',
      subject: '2 new notifications',
    });
    expect(email?.text).toContain('First');
    expect(email?.text).toContain('Second');
    expect(email?.text).not.toContain('plain comment');
    expect(email?.headers['List-Unsubscribe']).toMatch(
      /^<http:\/\/localhost:3000\/unsubscribe\/[^>]+\.assigned\.[^>]+>$/,
    );
    expect(email?.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const rows = db.orm.select().from(notification).where(eq(notification.userId, b.userId)).all();
    expect(rows.filter((r) => r.type === 'assigned').every((r) => r.emailedAt !== null)).toBe(true);
    expect(rows.find((r) => r.type === 'comment')?.emailedAt).toBeNull();
  });

  it('immediate: one email per notification, right after commit', async () => {
    const { app, mail, a, b, org } = await mailPair();
    await b.ok('PATCH', '/api/v1/me', { prefs: { emailMode: 'immediate' } });
    const task = await createTask(a, { title: 'Now', assigneeId: b.userId }, org.id);
    await idle({ app });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]?.subject).toBe('Ann Andersson assigned a task to you: Now');
    expect(mail.sent[0]?.html).toContain(`http://localhost:3000/o/${org.slug}/t/${task.id}`);
    expect(mail.sent[0]?.html).toContain('Open task');
    // The batch job has nothing left to send.
    expect(await app.services.mail.runBatches()).toBe(0);
  });

  it('a failed immediate send stays pending and goes out with the next batch', async () => {
    const { app, mail, a, b, org, time } = await mailPair();
    await b.ok('PATCH', '/api/v1/me', { prefs: { emailMode: 'immediate' } });
    mail.failing = true;
    await createTask(a, { title: 'Retry me', assigneeId: b.userId }, org.id);
    await idle({ app });
    expect(mail.sent).toEqual([]);
    mail.failing = false;
    time.advance(16 * MIN);
    expect(await app.services.mail.runBatches()).toBe(1);
    expect(mail.sent[0]?.subject).toBe('Ann Andersson assigned a task to you: Retry me');
  });

  it('no email with the email cell off, for my own actions, or to a removed member', async () => {
    const { app, mail, a, b, org, time } = await mailPair();
    await setCells(b, [{ type: 'assigned', channel: 'email', enabled: false }]);
    await createTask(a, { title: 'Quiet', assigneeId: b.userId }, org.id);
    await createTask(a, { title: 'Mine', assigneeId: a.userId }, org.id);
    // Switched off after the notification was queued: left out too.
    await setCells(b, [{ type: 'assigned', channel: 'email', enabled: true }]);
    await createTask(a, { title: 'Queued', assigneeId: b.userId }, org.id);
    await setCells(b, [{ type: 'assigned', channel: 'email', enabled: false }]);
    time.advance(16 * MIN);
    await app.services.mail.runBatches();
    await idle({ app });
    expect(mail.sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// AC-7.2: the daily digest
// ---------------------------------------------------------------------------------------------

/** Stable snapshots: IDs, slugs and unsubscribe tokens vary per run. */
function normalise(text: string): string {
  return text
    .replace(/\/unsubscribe\/[A-Za-z0-9._-]+/g, '/unsubscribe/<token>')
    .replace(/\/o\/[a-z0-9-]+\//g, '/o/<org>/')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>');
}

describe('daily digest (FR-NOT-3, AC-7.2)', () => {
  const morning = Date.UTC(2026, 9, 15, 5, 0); // 07:00 CEST

  async function digestUser(locale: 'en' | 'sv') {
    const time = manualClock(morning - 60 * MIN);
    const ctx = listCtx({ clock: time.clock, env: SMTP_ENV });
    const { a, b, org } = await pair(ctx);
    await a.ok('PATCH', '/api/v1/me', { timezone: STOCKHOLM, locale });
    await setCells(a, [{ type: 'digest', channel: 'email', enabled: true }]);
    // Ann's own tasks sit in a group of hers; only Bo's lands in an Inbox.
    const groupId = (await groupNamed(a, 'Upcoming')).id;
    await createTask(a, { title: 'Renew passport', dueDate: '2026-10-12', groupId });
    await createTask(a, { title: 'Write the report', dueDate: '2026-10-15', groupId });
    await createTask(a, {
      title: 'Call the bank',
      dueDate: '2026-10-15',
      dueTime: '16:00',
      dueTz: STOCKHOLM,
      groupId,
    });
    await createTask(a, { title: 'Next week', dueDate: '2026-10-20', groupId });
    // Bo assigns Ann a task in Acme: it lands in her Acme Inbox.
    await createTask(b, { title: 'Review the budget', assigneeId: a.userId }, org.id);
    ctx.mail.clear();
    return { ...ctx, a, b, org, time };
  }

  for (const locale of ['en', 'sv'] as const) {
    it(`AC-7.2 renders in ${locale} (HTML and text) and its unsubscribe link disables only the digest`, async () => {
      const { app, mail, a, time } = await digestUser(locale);
      time.set(morning - MIN);
      expect(await app.services.mail.runDigests()).toBe(0);
      time.set(morning);
      expect(await app.services.mail.runDigests()).toBe(1);
      expect(await app.services.mail.runDigests()).toBe(0);
      expect(mail.sent).toHaveLength(1);
      const [email] = mail.sent;
      if (email === undefined) throw new Error('no digest');
      expect(email.to).toBe('ann@example.com');
      expect(email.subject).toMatchSnapshot('subject');
      expect(normalise(email.html)).toMatchSnapshot('html');
      expect(normalise(email.text)).toMatchSnapshot('text');

      const before = await prefs(a);
      const link = /^<http:\/\/localhost:3000(\/unsubscribe\/[^>]+)>$/.exec(
        email.headers['List-Unsubscribe'] ?? '',
      )?.[1];
      expect(link).toBeDefined();
      expect(email.html).toContain(`http://localhost:3000${link}`);
      const res = await app.request(link ?? '', { method: 'POST' });
      expect(res.status).toBe(200);
      const after = await prefs(a);
      const changed = after.prefs.filter((p, i) => p.enabled !== before.prefs[i]?.enabled);
      expect(changed).toEqual([{ type: 'digest', channel: 'email', enabled: false }]);
    });
  }

  it('lists only what is due or new: nothing → no email; new in Inbox since the last digest', async () => {
    const { app, mail, a, b, org, time } = await digestUser('en');
    time.set(morning);
    await app.services.mail.runDigests();
    expect(mail.sent[0]?.text).toContain('Review the budget');
    mail.clear();
    // The next morning: the old Inbox task is no longer new; a fresh one is.
    time.set(morning + 20 * 3_600_000);
    await createTask(b, { title: 'Sign the contract', assigneeId: a.userId }, org.id);
    time.set(morning + 24 * 3_600_000);
    await app.services.mail.runDigests();
    expect(mail.sent[0]?.text).toContain('Sign the contract');
    expect(mail.sent[0]?.text).not.toContain('Review the budget');

    // A user whose digest would be empty gets nothing (the day is still claimed).
    const time2 = manualClock(morning - MIN);
    const ctx2 = listCtx({ clock: time2.clock, env: SMTP_ENV });
    const empty = ctx2.user('empty@example.com');
    await empty.ok('PATCH', '/api/v1/me', { timezone: STOCKHOLM });
    await setCells(empty, [{ type: 'digest', channel: 'email', enabled: true }]);
    time2.set(morning);
    expect(await ctx2.app.services.mail.runDigests()).toBe(0);
    expect(ctx2.mail.sent).toEqual([]);
  });

  it('never lists tasks of an org the user is no longer a member of', async () => {
    const { app, mail, a, org, time, db } = await digestUser('en');
    // An inconsistent state: the membership is gone but placements and groups remain.
    db.orm
      .delete(member)
      .where(and(eq(member.organizationId, org.id), eq(member.userId, a.userId)))
      .run();
    time.set(morning);
    await app.services.mail.runDigests();
    expect(mail.sent[0]?.text).toContain('Renew passport');
    expect(mail.sent[0]?.text).not.toContain('Review the budget');
  });
});

// ---------------------------------------------------------------------------------------------
// AC-7.3 and invites (FR-ORG-3)
// ---------------------------------------------------------------------------------------------

describe('without SMTP (AC-7.3)', () => {
  it('reports email off, invites fall back to copyable links, and no mail job sends', async () => {
    const ctx = listCtx();
    const { a, b, org } = await pair(ctx);
    expect((await a.ok<Meta>('GET', '/api/v1/meta')).features).toMatchObject({
      email: false,
      push: true,
    });
    const invite = await a.ok<InviteCreated>(
      'POST',
      `/api/v1/orgs/${org.id}/invites`,
      { email: 'new@example.com', role: 'member' },
      201,
    );
    expect(invite.emailed).toBe(false);
    expect(invite.url).toMatch(/^http:\/\/localhost:3000\/invite\//);
    await setCells(b, [{ type: 'digest', channel: 'email', enabled: true }]);
    await createTask(a, { title: 'X', assigneeId: b.userId }, org.id);
    await idle(ctx);
    expect(await ctx.app.services.mail.runBatches()).toBe(0);
    expect(await ctx.app.services.mail.runDigests()).toBe(0);
    expect(ctx.mail.sent).toEqual([]);
    // Nothing is queued for email either.
    expect(
      ctx.db.orm
        .select()
        .from(notification)
        .all()
        .some((n) => n.data.includes('emailPending')),
    ).toBe(false);
  });
});

describe('invite emails (FR-ORG-3)', () => {
  it('sends the invite link in the inviter’s language and says so in the response', async () => {
    const ctx = listCtx({ env: SMTP_ENV });
    const a = ctx.user('ann@example.com', 'Ann Andersson');
    await a.ok('PATCH', '/api/v1/me', { locale: 'sv' });
    const org = await a.ok<{ id: string }>('POST', '/api/v1/orgs', { name: 'Acme' }, 201);
    const invite = await a.ok<InviteCreated>(
      'POST',
      `/api/v1/orgs/${org.id}/invites`,
      { email: 'New@Example.com', role: 'member' },
      201,
    );
    expect(invite.emailed).toBe(true);
    await idle(ctx);
    const [email] = ctx.mail.to('new@example.com');
    expect(email?.subject).toBe('Ann Andersson har bjudit in dig till Acme');
    expect(email?.html).toContain(invite.url);
    expect(email?.text).toContain(invite.url);
    expect(email?.html).toContain('lang="sv"');
    // An invite is not a subscription: no unsubscribe header.
    expect(email?.headers['List-Unsubscribe']).toBeUndefined();
    // Link invites are never emailed.
    const link = await a.ok<InviteCreated>(
      'POST',
      `/api/v1/orgs/${org.id}/invites`,
      { role: 'member' },
      201,
    );
    expect(link.emailed).toBe(false);
  });

  it('writes to an existing user in their own language', async () => {
    const ctx = listCtx({ env: SMTP_ENV });
    const a = ctx.user('ann@example.com', 'Ann Andersson');
    const known = ctx.user('known@example.com');
    await known.ok('PATCH', '/api/v1/me', { locale: 'sv' });
    const org = await a.ok<{ id: string }>('POST', '/api/v1/orgs', { name: 'Acme' }, 201);
    await a.ok(
      'POST',
      `/api/v1/orgs/${org.id}/invites`,
      { email: 'known@example.com', role: 'member' },
      201,
    );
    await idle(ctx);
    expect(ctx.mail.to('known@example.com')[0]?.subject).toBe(
      'Ann Andersson har bjudit in dig till Acme',
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Unsubscribe and the preference matrix (06 §2.6, WP 7.4)
// ---------------------------------------------------------------------------------------------

describe('unsubscribe links', () => {
  it('GET only asks: a localised page whose button POSTs back; nothing changes', async () => {
    const ctx = listCtx({ env: SMTP_ENV });
    const a = ctx.user('ann@example.com');
    await a.ok('PATCH', '/api/v1/me', { locale: 'sv' });
    const before = await prefs(a);
    const token = unsubscribeToken(TEST_ENV.ROOSTER_AUTH_SECRET, a.userId, 'mention');
    // A mail gateway prefetching the link, twice.
    for (let i = 0; i < 2; i++) {
      const res = await ctx.app.request(`/unsubscribe/${token}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/html/);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("form-action 'self'");
      const html = await res.text();
      expect(html).toContain('Vill du sluta få mejl om omnämnanden?');
      expect(html).toMatch(
        /<form[^>]* method="post"><button type="submit"[^>]*>Sluta få mejl om omnämnanden<\/button><\/form>/,
      );
      expect(html).not.toContain('<script');
    }
    expect(await prefs(a)).toEqual(before);
  });

  it('POST turns off exactly that category, with no session and any Origin (RFC 8058)', async () => {
    const ctx = listCtx({ env: SMTP_ENV });
    const a = ctx.user('ann@example.com');
    await a.ok('PATCH', '/api/v1/me', { locale: 'sv' });
    const before = await prefs(a);
    const token = unsubscribeToken(TEST_ENV.ROOSTER_AUTH_SECRET, a.userId, 'mention');
    // A mail provider's one-click: form-encoded, cross-site, no cookies.
    const res = await ctx.app.request(`/unsubscribe/${token}`, {
      method: 'POST',
      headers: {
        origin: 'https://mail.google.com',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'List-Unsubscribe=One-Click',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Du får inte längre mejl om omnämnanden.');
    const changed = (await prefs(a)).prefs.filter((p, i) => p.enabled !== before.prefs[i]?.enabled);
    expect(changed).toEqual([{ type: 'mention', channel: 'email', enabled: false }]);
    // The page's own button (Origin null after some redirects), and idempotent.
    const again = await ctx.app.request(`/unsubscribe/${token}`, {
      method: 'POST',
      headers: { origin: 'null' },
    });
    expect(again.status).toBe(200);
  });

  it('a forged, malformed or foreign-secret token is a 404 page, GET and POST alike', async () => {
    const ctx = listCtx({ env: SMTP_ENV });
    const a = ctx.user('ann@example.com');
    const valid = unsubscribeToken(TEST_ENV.ROOSTER_AUTH_SECRET, a.userId, 'digest');
    const forged = unsubscribeToken(
      'another-secret-0123456789-abcdefghijklmnop',
      a.userId,
      'digest',
    );
    for (const token of [
      forged,
      valid.replace('.digest.', '.mention.'),
      'nonsense',
      `${a.userId}.everything.x`,
    ]) {
      for (const method of ['GET', 'POST']) {
        const res = await ctx.app.request(`/unsubscribe/${token}`, {
          method,
          headers: { 'accept-language': 'en' },
        });
        expect(res.status, `${method} ${token}`).toBe(404);
        expect(await res.text()).toContain('This unsubscribe link is not valid.');
      }
    }
    // Nothing was stored for anyone.
    expect(ctx.db.sqlite.prepare('SELECT count(*) AS n FROM notification_pref').get()).toEqual({
      n: 0,
    });
  });
});

describe('preference matrix (FR-NOT-4, ADR 0033)', () => {
  it('GET has all 20 cells with defaults; PUT takes any valid cell and rejects others', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const matrix = await prefs(a);
    expect(matrix.prefs).toHaveLength(20);
    const on = (type: string, channel: string) =>
      matrix.prefs.find((p) => p.type === type && p.channel === channel)?.enabled;
    expect(on('comment', 'inapp')).toBe(true);
    expect(on('comment', 'push')).toBe(true);
    expect(on('comment', 'email')).toBe(false);
    expect(on('mention', 'email')).toBe(true);
    expect(on('assigned', 'email')).toBe(true);
    expect(on('digest', 'email')).toBe(false);
    expect(on('due_reminder', 'push')).toBe(false);

    const put = await setCells(a, [
      { type: 'comment', channel: 'email', enabled: true },
      { type: 'due_reminder', channel: 'push', enabled: true },
    ]);
    expect(put.prefs.filter((p) => p.type === 'due_reminder')).toEqual([
      { type: 'due_reminder', channel: 'push', enabled: true },
    ]);
    // Only changed cells are stored.
    expect(ctx.db.sqlite.prepare('SELECT count(*) AS n FROM notification_pref').get()).toEqual({
      n: 2,
    });
    const bad = await a.call('PUT', '/api/v1/me/notification-prefs', {
      prefs: [
        { type: 'digest', channel: 'email', enabled: true },
        { type: 'digest', channel: 'push', enabled: true },
      ],
    });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as Problem).errors?.map((e) => e.path)).toEqual(['prefs.1.channel']);
  });

  it('PATCH /me takes the reminder and digest times and the email mode', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const me = await a.ok<{ prefs: Record<string, unknown> }>('PATCH', '/api/v1/me', {
      prefs: { reminderTime: '06:45', digestTime: '18:30', emailMode: 'immediate' },
    });
    expect(me.prefs).toMatchObject({
      reminderTime: '06:45',
      digestTime: '18:30',
      emailMode: 'immediate',
    });
    expect((await a.call('PATCH', '/api/v1/me', { prefs: { emailMode: 'weekly' } })).status).toBe(
      422,
    );
  });
});

describe('meta features (06 §2.1)', () => {
  it('email follows SMTP; push is on once keys exist', async () => {
    const withSmtp = createTestApp({ env: SMTP_ENV, mail: new FakeMail(), push: new FakePush() });
    const body = (await (await withSmtp.app.request('/api/v1/meta')).json()) as Meta;
    expect(body.features).toEqual({ email: true, push: true, s3: false });
  });
});
