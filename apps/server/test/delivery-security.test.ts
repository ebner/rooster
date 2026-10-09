// Security review of Phase 7 delivery: push SSRF via non-canonical endpoints, queued sends to
// subscriptions that moved, device renewal, unsubscribe tokens in logs, timed tasks overdue
// across timezones, and the catch-up digest's date.

import { parse as legacyParse } from 'node:url';
import { uuidv7 } from '@rooster/core/ids';
import { isAllowedPushEndpoint } from '@rooster/core/push-hosts';
import type { Problem, PushSubscriptionInfo } from '@rooster/core/schemas';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { pushSubscription } from '../src/db/schema/index.ts';
import { loggablePath } from '../src/lib/request-log.ts';
import { unsubscribeToken } from '../src/mail/unsubscribe-token.ts';
import { canonicalPushEndpoint } from '../src/push/endpoint.ts';
import { fcmEndpoint, SMTP_ENV, subscriptionBody } from './delivery-fakes.ts';
import { captureLogger, createTestApp, TEST_ENV } from './helpers.ts';
import { type Caller, createTask, groupNamed, listCtx } from './list-helpers.ts';

const MIN = 60_000;

function manualClock(start: number) {
  let now = start;
  return {
    clock: () => now++,
    set: (at: number) => {
      now = at;
    },
  };
}

const setCells = (c: Caller, cells: { type: string; channel: string; enabled: boolean }[]) =>
  c.ok('PUT', '/api/v1/me/notification-prefs', { prefs: cells });

/** A row as an older server (or a future code path) might have stored it, unchecked. */
function storeRaw(db: ReturnType<typeof listCtx>['db'], userId: string, endpoint: string): string {
  const id = uuidv7();
  db.orm
    .insert(pushSubscription)
    .values({
      id,
      userId,
      endpoint,
      p256dh: subscriptionBody('x').keys.p256dh,
      auth: subscriptionBody('x').keys.auth,
      userAgent: null,
      createdAt: 1,
      lastOkAt: null,
    })
    .run();
  return id;
}

// ---------------------------------------------------------------------------------------------
// [P1] Push SSRF through endpoints whose raw string and WHATWG host disagree
// ---------------------------------------------------------------------------------------------

describe('push endpoints: only canonical URLs reach the transport', () => {
  const bypass = 'https://127.0.0.1%2efcm.googleapis.com/fcm/send/x';

  it('the raw bypass is refused by the host check; the legacy parser would connect to 127.0.0.1', () => {
    // The finding itself: the legacy parser resolves the raw string to another host, so the
    // allowlist accepts only canonical URLs and the transport only ever gets the canonical form.
    expect(legacyParse(bypass).hostname).toBe('127.0.0.1');
    expect(isAllowedPushEndpoint(bypass)).toBe(false);
  });

  it.each([
    [bypass, 'https://127.0.0.1.fcm.googleapis.com/fcm/send/x'],
    ['https://FCM.GOOGLEAPIS.COM/fcm/send/x', 'https://fcm.googleapis.com/fcm/send/x'],
    ['https://fcm%2Egoogleapis.com/fcm/send/x', 'https://fcm.googleapis.com/fcm/send/x'],
    ['https://fcm.googleapis.com./fcm/send/x', null],
    ['https://127.0.0.1%252efcm.googleapis.com/x', null],
    ['https://fcm.googleapis.cöm/x', null],
    ['https://127.0.0.1/x', null],
  ])('%s is sent as %s', (raw, expected) => {
    const canonical = canonicalPushEndpoint(raw);
    expect(canonical).toBe(expected);
    if (canonical !== null) {
      // Whatever the transport's URL parser, it connects to the host that was checked.
      expect(legacyParse(canonical).hostname).toBe(new URL(canonical).hostname);
    }
  });

  it('a stored non-canonical endpoint is sent to its canonical form only', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const id = storeRaw(ctx.db, a.userId, bypass);
    await a.ok('POST', `/api/v1/me/push-subscriptions/${id}/test`, undefined, 204);
    expect(ctx.push.sent.map((s) => s.endpoint)).toEqual([
      'https://127.0.0.1.fcm.googleapis.com/fcm/send/x',
    ]);
  });

  it('a stored endpoint that does not parse, or is off the list, is deleted unsent', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const id = storeRaw(ctx.db, a.userId, 'https://127.0.0.1%252efcm.googleapis.com/x');
    expect((await a.call('POST', `/api/v1/me/push-subscriptions/${id}/test`)).status).toBe(410);
    expect(ctx.push.sent).toEqual([]);
    expect(ctx.db.orm.select().from(pushSubscription).all()).toEqual([]);
  });

  it.each([
    bypass,
    'https://127.0.0.1%252efcm.googleapis.com/x',
    'https://FCM.googleapis.com/fcm/send/x',
    'https://fcm%2Egoogleapis.com/fcm/send/x',
    'https://fcm.googleapis.cöm/x',
  ])('subscribing %s is 422: only canonical endpoints are stored', async (endpoint) => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const res = await a.call('POST', '/api/v1/me/push-subscriptions', {
      ...subscriptionBody('x'),
      endpoint,
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as Problem).errors?.[0]?.path).toBe('endpoint');
    expect(ctx.db.orm.select().from(pushSubscription).all()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// [P1] Queued sends must not follow a subscription that moved or went away
// ---------------------------------------------------------------------------------------------

describe('queued pushes re-check the subscription right before sending', () => {
  it('a reminder queued for Ann is not sent once the device moved to Bo', async () => {
    const at = Date.UTC(2026, 9, 15, 6, 0); // 08:00 CEST
    const time = manualClock(at - 60 * MIN);
    const ctx = listCtx({ clock: time.clock });
    const ann = ctx.user('ann@example.com');
    const bo = ctx.user('bo@example.com');
    await ann.ok('PATCH', '/api/v1/me', { timezone: 'Europe/Stockholm' });
    await setCells(ann, [{ type: 'due_reminder', channel: 'push', enabled: true }]);
    await ann.ok('POST', '/api/v1/me/push-subscriptions', subscriptionBody('shared'), 201);
    await createTask(ann, { title: 'Ann’s secret', dueDate: '2026-10-15' });

    // Fill every delivery slot so the reminder waits in the queue.
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blockers = Array.from({ length: 4 }, () =>
      ctx.app.services.deliveries.run('blocker', () => gate),
    );
    time.set(at);
    const reminders = ctx.app.services.push.runDueReminders();
    // Meanwhile Bo signs in on that browser and subscribes: the endpoint is his now.
    await bo.ok('POST', '/api/v1/me/push-subscriptions', subscriptionBody('shared'), 201);
    release();
    await Promise.all([reminders, ...blockers]);
    expect(ctx.push.sent).toEqual([]);
  });

  it('a notification push queued before the device was removed is not sent', async () => {
    const ctx = listCtx();
    const ann = ctx.user('ann@example.com');
    const sub = await ann.ok<PushSubscriptionInfo>(
      'POST',
      '/api/v1/me/push-subscriptions',
      subscriptionBody('gone-soon'),
      201,
    );
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blockers = Array.from({ length: 4 }, () =>
      ctx.app.services.deliveries.run('blocker', () => gate),
    );
    // Reads the subscription and queues the send before it returns its promise.
    const test = ctx.app.services.push.test(ann.actor, sub.id).then(
      () => 'sent',
      (err: { code?: string }) => err.code,
    );
    await ann.ok('DELETE', `/api/v1/me/push-subscriptions/${sub.id}`, undefined, 204);
    release();
    await Promise.all(blockers);
    expect(await test).toBe('push_gone');
    expect(ctx.push.sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// [P1] Renewal (pushsubscriptionchange) cannot resurrect a removed device
// ---------------------------------------------------------------------------------------------

describe('push subscription renewal', () => {
  const renew = (c: Caller, from: string, to: string) =>
    c.call('POST', '/api/v1/me/push-subscriptions', {
      ...subscriptionBody(to),
      renewsEndpoint: fcmEndpoint(from),
    });

  it('replaces my live subscription in place, keeping its id', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const old = await a.ok<PushSubscriptionInfo>(
      'POST',
      '/api/v1/me/push-subscriptions',
      subscriptionBody('v1'),
      201,
    );
    const res = await renew(a, 'v1', 'v2');
    expect(res.status).toBe(201);
    const renewed = (await res.json()) as PushSubscriptionInfo;
    expect(renewed.id).toBe(old.id);
    const rows = ctx.db.orm.select().from(pushSubscription).all();
    expect(rows.map((r) => r.endpoint)).toEqual([fcmEndpoint('v2')]);
  });

  it('is 410 push_gone once I removed the device, and stores nothing', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const sub = await a.ok<PushSubscriptionInfo>(
      'POST',
      '/api/v1/me/push-subscriptions',
      subscriptionBody('v1'),
      201,
    );
    await a.ok('DELETE', `/api/v1/me/push-subscriptions/${sub.id}`, undefined, 204);
    const res = await renew(a, 'v1', 'v2');
    expect(res.status).toBe(410);
    expect(((await res.json()) as Problem).code).toBe('push_gone');
    expect(ctx.db.orm.select().from(pushSubscription).all()).toEqual([]);
  });

  it('is 410 for someone else’s subscription; a same-endpoint renewal only updates keys', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const b = ctx.user('b@example.com');
    await b.ok('POST', '/api/v1/me/push-subscriptions', subscriptionBody('bo'), 201);
    expect((await renew(a, 'bo', 'v2')).status).toBe(410);
    const rows = ctx.db.orm.select().from(pushSubscription).all();
    expect(rows.map((r) => [r.userId, r.endpoint])).toEqual([[b.userId, fcmEndpoint('bo')]]);
    const same = await renew(b, 'bo', 'bo');
    expect(same.status).toBe(201);
  });

  it('cannot take over an endpoint that belongs to another user (409)', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const b = ctx.user('b@example.com');
    await a.ok('POST', '/api/v1/me/push-subscriptions', subscriptionBody('ann'), 201);
    await b.ok('POST', '/api/v1/me/push-subscriptions', subscriptionBody('bo'), 201);
    const res = await renew(a, 'ann', 'bo');
    expect(res.status).toBe(409);
    expect(((await res.json()) as Problem).code).toBe('push_endpoint_taken');
    const owners = ctx.db.orm
      .select()
      .from(pushSubscription)
      .where(eq(pushSubscription.endpoint, fcmEndpoint('bo')))
      .all();
    expect(owners.map((r) => r.userId)).toEqual([b.userId]);
  });

  it('applies the endpoint rules to renewsEndpoint too', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const res = await a.call('POST', '/api/v1/me/push-subscriptions', {
      ...subscriptionBody('v2'),
      renewsEndpoint: 'https://127.0.0.1/x',
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as Problem).errors?.[0]?.path).toBe('renewsEndpoint');
  });
});

describe('a send to an endpoint that was renewed meanwhile', () => {
  async function inFlight(answer: number | null) {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const sub = await a.ok<PushSubscriptionInfo>(
      'POST',
      '/api/v1/me/push-subscriptions',
      subscriptionBody('v1'),
      201,
    );
    if (answer !== null) ctx.push.failWith.set(fcmEndpoint('v1'), answer);
    let release = () => {};
    ctx.push.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The send to v1 is out at the push service when the browser renews to v2.
    const sent = ctx.app.services.push.test(a.actor, sub.id).then(
      () => 'sent',
      (err: { code?: string }) => err.code,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const res = await a.call('POST', '/api/v1/me/push-subscriptions', {
      ...subscriptionBody('v2'),
      renewsEndpoint: fcmEndpoint('v1'),
    });
    expect(res.status).toBe(201);
    release();
    return { ctx, sub, outcome: await sent };
  }

  it('a late 410 for the old endpoint does not delete the renewed subscription', async () => {
    const { ctx, sub, outcome } = await inFlight(410);
    expect(outcome).toBe('push_gone');
    const rows = ctx.db.orm.select().from(pushSubscription).all();
    expect(rows.map((r) => [r.id, r.endpoint])).toEqual([[sub.id, fcmEndpoint('v2')]]);
  });

  it('a late success for the old endpoint does not credit the renewed subscription', async () => {
    const { ctx, outcome } = await inFlight(null);
    expect(outcome).toBe('sent');
    expect(ctx.db.orm.select().from(pushSubscription).get()?.lastOkAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// [P2] Unsubscribe tokens in request logs
// ---------------------------------------------------------------------------------------------

describe('request log redaction of unsubscribe tokens', () => {
  it('redacts the token in the path', () => {
    expect(loggablePath('/unsubscribe/abc.digest.sig')).toBe('/unsubscribe/:token');
  });

  it('GET and POST request lines never contain the token', async () => {
    const { logger, lines } = captureLogger();
    const { app, db } = createTestApp({ logger, env: SMTP_ENV });
    const ctx = listCtx({ db });
    const a = ctx.user('a@example.com');
    const token = unsubscribeToken(TEST_ENV.ROOSTER_AUTH_SECRET, a.userId, 'digest');
    await app.request(`/unsubscribe/${token}`);
    await app.request(`/unsubscribe/${token}`, { method: 'POST' });
    const requests = lines.filter((l) => l.msg === 'request');
    expect(requests.map((l) => [l.method, l.path])).toEqual([
      ['GET', '/unsubscribe/:token'],
      ['POST', '/unsubscribe/:token'],
    ]);
    expect(JSON.stringify(lines)).not.toContain(token.split('.')[2] ?? token);
  });
});

// ---------------------------------------------------------------------------------------------
// [P2] Timed tasks overdue although dated after the viewer's today
// ---------------------------------------------------------------------------------------------

describe('timed dues across timezones', () => {
  it('the reminder includes a timed task already overdue but dated tomorrow or later locally', async () => {
    // Ann lives at UTC−12; the tasks were timed in Kiritimati (UTC+14).
    const at = Date.UTC(2026, 9, 16, 11, 0); // 23:00 on the 15th at UTC−12
    const time = manualClock(at - 60 * MIN);
    const ctx = listCtx({ clock: time.clock });
    const ann = ctx.user('ann@example.com');
    await ann.ok('PATCH', '/api/v1/me', {
      timezone: 'Etc/GMT+12',
      prefs: { reminderTime: '23:00' },
    });
    await setCells(ann, [{ type: 'due_reminder', channel: 'push', enabled: true }]);
    await ann.ok('POST', '/api/v1/me/push-subscriptions', subscriptionBody('p'), 201);
    const tz = 'Pacific/Kiritimati';
    // 16th 09:00 +14 = 15th 19:00Z; 17th 00:00 +14 = 16th 10:00Z: both passed at 16th 11:00Z.
    await createTask(ann, {
      title: 'Tomorrow, passed',
      dueDate: '2026-10-16',
      dueTime: '09:00',
      dueTz: tz,
    });
    await createTask(ann, {
      title: 'Day after, passed',
      dueDate: '2026-10-17',
      dueTime: '00:00',
      dueTz: tz,
    });
    await createTask(ann, { title: 'Not yet', dueDate: '2026-10-17', dueTime: '02:00', dueTz: tz });
    time.set(at);
    expect(await ctx.app.services.push.runDueReminders()).toBe(1);
    expect(ctx.push.sent[0]?.payload).toMatchObject({
      title: '2 tasks today',
      body: 'Tomorrow, passed\nDay after, passed',
    });
  });
});

// ---------------------------------------------------------------------------------------------
// [P2] A catch-up digest after midnight is about the day it was due
// ---------------------------------------------------------------------------------------------

describe('catch-up digest date', () => {
  it('a 23:55 digest sent at 00:02 lists that day’s tasks as due today', async () => {
    const due = Date.UTC(2026, 9, 15, 21, 55); // 23:55 CEST on the 15th
    const time = manualClock(due - 60 * MIN);
    const ctx = listCtx({ clock: time.clock, env: SMTP_ENV });
    const ann = ctx.user('ann@example.com');
    await ann.ok('PATCH', '/api/v1/me', {
      timezone: 'Europe/Stockholm',
      prefs: { digestTime: '23:55' },
    });
    await setCells(ann, [{ type: 'digest', channel: 'email', enabled: true }]);
    const groupId = (await groupNamed(ann, 'Upcoming')).id;
    await createTask(ann, { title: 'Fifteenth', dueDate: '2026-10-15', groupId });
    await createTask(ann, { title: 'Sixteenth', dueDate: '2026-10-16', groupId });
    time.set(due + 7 * MIN); // 00:02 on the 16th
    expect(await ctx.app.services.mail.runDigests()).toBe(1);
    const [email] = ctx.mail.sent;
    expect(email?.subject).toBe('Your day: Thursday, October 15');
    const text = email?.text ?? '';
    expect(text).not.toContain('Overdue');
    expect(text.indexOf('Due today')).toBeLessThan(text.indexOf('Fifteenth'));
    expect(text).not.toContain('Sixteenth');
  });
});
