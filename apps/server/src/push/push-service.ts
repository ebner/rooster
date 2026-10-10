import { uuidv7 } from '@rooster/core/ids';
import type {
  PushPayload,
  PushSubscriptionCreate,
  PushSubscriptionInfo,
  VapidPublicKey,
} from '@rooster/core/schemas';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { notification, pushSubscription } from '../db/schema/index.ts';
import { AppError } from '../lib/errors.ts';
import { logSafeError } from '../lib/log-safe-error.ts';
import type { TaskQueue } from '../lib/task-queue.ts';
import { describeNotification } from '../mail/describe.ts';
import { mailT } from '../mail/i18n.ts';
import { dueContext, tasksDueByToday, todayOrg } from '../services/assigned-tasks.ts';
import { type Actor, immediate, readOnly, type ServiceDeps, type Tx } from '../services/context.ts';
import { loadDeliverable } from '../services/deliverable.ts';
import { requireBrowserSession } from '../services/grant-access.ts';
import { claimJobRun, dueSlot, jobScope } from '../services/job-runs.ts';
import { loadRecipient, type Recipient, recipientsWithPref } from '../services/pref-store.ts';
import { canonicalPushEndpoint } from './endpoint.ts';
import {
  generateVapidKeys,
  type PushSender,
  type PushSendOptions,
  pushStatusOf,
} from './transport.ts';
import { ensureVapidKeys, type VapidKeys, writeKeys } from './vapid.ts';

type SubscriptionRow = typeof pushSubscription.$inferSelect;

/** Which device a queued send is for, and on whose behalf; re-checked before sending. */
interface SubscriptionRef {
  id: string;
  userId: string;
}

/** Retention and priority at the push service, by kind. */
const DELIVERY: Record<PushPayload['kind'], Pick<PushSendOptions, 'ttl' | 'urgency'>> = {
  // An assignment or mention seen a day later is still worth showing.
  notification: { ttl: 24 * 3600, urgency: 'normal' },
  // A morning reminder is stale by the afternoon.
  due_reminder: { ttl: 4 * 3600, urgency: 'high' },
  // The user is looking at the settings screen waiting for it.
  test: { ttl: 5 * 60, urgency: 'high' },
};

/** Push services cap payloads at about 4 KB; titles can be 500 characters. */
const TITLE_MAX = 120;
const BODY_MAX = 300;
/** Task titles listed in a due reminder before "and N more". */
const REMINDER_TITLES = 3;

export const DUE_REMINDER_JOB = 'due_reminder';

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function toInfo(row: SubscriptionRow): PushSubscriptionInfo {
  return {
    id: row.id,
    userAgent: row.userAgent,
    createdAt: row.createdAt,
    lastOkAt: row.lastOkAt,
  };
}

/**
 * The row as it was when a message went out. A renewal keeps the id but replaces endpoint and
 * keys, so a late answer about the old endpoint (404/410, or success) must neither delete nor
 * credit the renewed row.
 */
function sameAsSent(sent: SubscriptionRow) {
  return and(
    eq(pushSubscription.id, sent.id),
    eq(pushSubscription.endpoint, sent.endpoint),
    eq(pushSubscription.p256dh, sent.p256dh),
    eq(pushSubscription.auth, sent.auth),
  );
}

const notFound = () => new AppError('not_found', 404, 'Push subscription not found.');

type Outcome = 'ok' | 'gone' | 'failed';

/**
 * Web Push (FR-NOT-2): VAPID keys, the user's subscribed devices, and delivery. Sends run on
 * the delivery queue after commit, never inside a transaction or a request.
 */
export class PushService {
  private keys: VapidKeys | null = null;

  constructor(
    private readonly deps: ServiceDeps,
    private readonly queue: TaskQueue,
    private readonly sender: PushSender,
  ) {}

  /** Boot (08 §2): makes sure a key pair exists. Idempotent. */
  ensureKeys(): VapidKeys {
    this.keys ??= ensureVapidKeys(this.deps.db, this.deps.config.vapid);
    return this.keys;
  }

  /** Keys exist once the server has booted, so push is always available. */
  enabled(): boolean {
    return true;
  }

  publicKey(): VapidPublicKey {
    return { publicKey: this.ensureKeys().publicKey };
  }

  hasSubscription(tx: Tx, userId: string): boolean {
    return (
      tx
        .select({ id: pushSubscription.id })
        .from(pushSubscription)
        .where(eq(pushSubscription.userId, userId))
        .limit(1)
        .get() !== undefined
    );
  }

  list(actor: Actor): PushSubscriptionInfo[] {
    requireBrowserSession(actor);
    return readOnly(this.deps.db, (tx) =>
      tx
        .select()
        .from(pushSubscription)
        .where(eq(pushSubscription.userId, actor.userId))
        .orderBy(desc(pushSubscription.createdAt), desc(pushSubscription.id))
        .all()
        .map(toInfo),
    );
  }

  /**
   * The user-gesture path (Settings): upserts by endpoint (ADR 0033), so re-subscribing a
   * browser updates its keys and owner, and a shared computer's subscription follows whoever
   * subscribed on it last.
   *
   * With `renewsEndpoint` it is a renewal from the service worker (`pushsubscriptionchange`,
   * no gesture). It only replaces a live subscription of the same user, in place, so a device
   * the user removed (from any device) never comes back by itself: `410 push_gone`. It never
   * takes over an endpoint another user holds (`409 push_endpoint_taken`).
   */
  subscribe(
    actor: Actor,
    input: PushSubscriptionCreate,
    userAgentHeader: string | null,
  ): PushSubscriptionInfo {
    requireBrowserSession(actor);
    return immediate(this.deps.db, (tx) => {
      const userAgent = input.userAgent ?? userAgentHeader?.slice(0, 256) ?? null;
      const values = {
        userId: actor.userId,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        userAgent,
      };
      for (const path of ['endpoint', 'renewsEndpoint'] as const) {
        const raw = input[path];
        if (raw !== undefined && canonicalPushEndpoint(raw) !== raw) {
          throw new AppError('validation_failed', 422, 'Not a canonical push endpoint.', [
            { path, message: 'Not a canonical URL on a known Web Push service' },
          ]);
        }
      }
      if (input.renewsEndpoint !== undefined) {
        return this.renew(tx, actor, input.renewsEndpoint, input.endpoint, values);
      }
      const row = tx
        .insert(pushSubscription)
        .values({
          id: uuidv7(),
          endpoint: input.endpoint,
          createdAt: this.deps.clock(),
          lastOkAt: null,
          ...values,
        })
        .onConflictDoUpdate({ target: pushSubscription.endpoint, set: values })
        .returning()
        .get();
      return toInfo(row);
    });
  }

  private renew(
    tx: Tx,
    actor: Actor,
    oldEndpoint: string,
    endpoint: string,
    values: { userId: string; p256dh: string; auth: string; userAgent: string | null },
  ): PushSubscriptionInfo {
    const old = tx
      .select()
      .from(pushSubscription)
      .where(
        and(eq(pushSubscription.endpoint, oldEndpoint), eq(pushSubscription.userId, actor.userId)),
      )
      .get();
    if (old === undefined) {
      throw new AppError('push_gone', 410, 'This device is no longer subscribed; subscribe again.');
    }
    const holder = tx
      .select()
      .from(pushSubscription)
      .where(eq(pushSubscription.endpoint, endpoint))
      .get();
    if (holder !== undefined && holder.id !== old.id) {
      if (holder.userId !== actor.userId) {
        throw new AppError(
          'push_endpoint_taken',
          409,
          'This push endpoint belongs to another account; subscribe again from Settings.',
        );
      }
      // Already subscribed under the new endpoint: the old row is simply redundant.
      tx.delete(pushSubscription).where(eq(pushSubscription.id, old.id)).run();
      const kept = tx
        .update(pushSubscription)
        .set(values)
        .where(eq(pushSubscription.id, holder.id))
        .returning()
        .get();
      return toInfo(kept ?? holder);
    }
    const row = tx
      .update(pushSubscription)
      .set({ ...values, endpoint })
      .where(eq(pushSubscription.id, old.id))
      .returning()
      .get();
    return toInfo(row ?? old);
  }

  unsubscribe(actor: Actor, id: string): void {
    requireBrowserSession(actor);
    immediate(this.deps.db, (tx) => {
      const changes = tx
        .delete(pushSubscription)
        .where(and(eq(pushSubscription.id, id), eq(pushSubscription.userId, actor.userId)))
        .run().changes;
      if (changes === 0) throw notFound();
    });
  }

  /**
   * POST /me/push-subscriptions/:id/test: sends a test message and waits for the push
   * service. A subscription the service no longer knows is deleted (`410 push_gone`); any
   * other refusal is `502 push_failed`.
   */
  async test(actor: Actor, id: string): Promise<void> {
    requireBrowserSession(actor);
    const row = readOnly(this.deps.db, (tx) =>
      tx
        .select()
        .from(pushSubscription)
        .where(and(eq(pushSubscription.id, id), eq(pushSubscription.userId, actor.userId)))
        .get(),
    );
    if (row === undefined) throw notFound();
    const recipient = readOnly(this.deps.db, (tx) => loadRecipient(tx, actor.userId));
    const target: SubscriptionRef = { id: row.id, userId: actor.userId };
    const t = mailT(recipient?.locale ?? 'en');
    const outcome = await this.queue.run('push-test', () =>
      this.deliver(target, {
        kind: 'test',
        title: t('push.testTitle'),
        body: t('push.testBody'),
        url: '/settings/notifications',
        tag: 'test',
      }),
    );
    if (outcome === 'gone') {
      throw new AppError('push_gone', 410, 'This device is no longer subscribed; subscribe again.');
    }
    if (outcome !== 'ok') {
      throw new AppError('push_failed', 502, 'The push service did not accept the message.');
    }
  }

  /**
   * POST /admin/push-keys/regenerate (08 §8): a new key pair, and every subscription goes,
   * since none of them can be reached with the new keys. Devices subscribe again when the
   * app next opens. Keys from the environment cannot be replaced here (`409`).
   */
  regenerate(actor: Actor): VapidPublicKey {
    requireBrowserSession(actor);
    if (!actor.isAdmin) throw new AppError('forbidden', 403, 'Only instance admins can do that.');
    if (this.deps.config.vapid !== null) {
      throw new AppError(
        'push_keys_from_env',
        409,
        'The push keys are set by ROOSTER_VAPID_PUBLIC and ROOSTER_VAPID_PRIVATE; change them there.',
      );
    }
    this.keys = immediate(this.deps.db, (tx) => {
      tx.delete(pushSubscription).run();
      return writeKeys(tx, generateVapidKeys());
    });
    this.deps.logger.warn({ by: actor.userId }, 'push keys regenerated; subscriptions dropped');
    return { publicKey: this.keys.publicKey };
  }

  /**
   * After commit: pushes each new notification to its recipient's devices. `pushed_at` is
   * set once any device's push service accepted it.
   */
  sendNotifications(ids: readonly string[]): void {
    for (const id of ids) {
      void this.queue.run('push-notification', () => this.sendNotification(id));
    }
  }

  private async sendNotification(id: string): Promise<void> {
    const loaded = readOnly(this.deps.db, (tx) => {
      const found = loadDeliverable(tx, id);
      return found === null
        ? null
        : { ...found, subscriptions: this.subscriptionsOf(tx, found.row.userId) };
    });
    if (loaded === null || loaded.subscriptions.length === 0) return;
    const t = mailT(loaded.recipient.locale);
    const described = describeNotification(
      loaded.notification,
      loaded.recipient,
      t,
      this.deps.clock(),
    );
    const { taskId } = loaded.notification;
    // A task reminder (ADR 0049 §2.3) reads as the task itself: its title, then when it is
    // due. Its own tag keeps it apart from other news about the task.
    const payload: PushPayload =
      loaded.notification.type === 'reminder'
        ? {
            kind: 'notification',
            title: described.subject,
            body: described.when ?? described.event,
            url: described.path,
            tag: taskId === null ? `notification:${id}` : `reminder:${taskId}`,
          }
        : {
            kind: 'notification',
            title: described.event,
            body:
              described.quote === undefined
                ? described.subject
                : `${described.subject}\n${described.quote}`,
            url: described.path,
            tag: taskId === null ? `notification:${id}` : `task:${taskId}`,
          };
    const outcomes = await Promise.all(loaded.subscriptions.map((s) => this.deliver(s, payload)));
    if (outcomes.includes('ok')) {
      immediate(this.deps.db, (tx) => {
        tx.update(notification)
          .set({ pushedAt: this.deps.clock() })
          .where(and(eq(notification.id, id), isNull(notification.pushedAt)))
          .run();
      });
    }
  }

  private subscriptionsOf(tx: Tx, userId: string): SubscriptionRef[] {
    return tx
      .select({ id: pushSubscription.id, userId: pushSubscription.userId })
      .from(pushSubscription)
      .where(eq(pushSubscription.userId, userId))
      .orderBy(asc(pushSubscription.createdAt))
      .all();
  }

  /**
   * One message to one device. The subscription is read again right before sending: a send
   * queued for one user must not reach a device that was removed meanwhile or now belongs to
   * someone else (`subscribe` moves an endpoint to whoever subscribed it last). Only the
   * canonical endpoint goes to the transport (`canonicalPushEndpoint`, 04 §4.11); a stored
   * one that is not allowed is deleted unsent. 404 and 410 delete the subscription; other
   * failures are logged and never thrown.
   */
  private async deliver(target: SubscriptionRef, payload: PushPayload): Promise<Outcome> {
    const log = this.deps.logger.child({ subscription: target.id, kind: payload.kind });
    const row = readOnly(this.deps.db, (tx) =>
      tx
        .select()
        .from(pushSubscription)
        .where(and(eq(pushSubscription.id, target.id), eq(pushSubscription.userId, target.userId)))
        .get(),
    );
    if (row === undefined) return 'gone';
    const endpoint = canonicalPushEndpoint(row.endpoint);
    if (endpoint === null) {
      this.remove(row);
      log.warn('push subscription with a disallowed endpoint deleted');
      return 'gone';
    }
    const message: PushPayload = {
      ...payload,
      title: clip(payload.title, TITLE_MAX),
      body: clip(payload.body, BODY_MAX),
    };
    try {
      await this.sender(
        { endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        JSON.stringify(message),
        { ...DELIVERY[payload.kind], vapid: this.vapid() },
      );
    } catch (err) {
      const status = pushStatusOf(err);
      if (status === 404 || status === 410) {
        this.remove(row);
        log.info({ status }, 'push subscription expired; deleted');
        return 'gone';
      }
      log.warn({ err: logSafeError(err), status }, 'push failed');
      return 'failed';
    }
    immediate(this.deps.db, (tx) => {
      tx.update(pushSubscription).set({ lastOkAt: this.deps.clock() }).where(sameAsSent(row)).run();
    });
    return 'ok';
  }

  /** Deletes the subscription only while it is still what was sent to (see `sameAsSent`). */
  private remove(sent: SubscriptionRow): void {
    immediate(this.deps.db, (tx) => {
      tx.delete(pushSubscription).where(sameAsSent(sent)).run();
    });
  }

  private vapid() {
    const keys = this.ensureKeys();
    return {
      subject: this.deps.config.vapidSubject,
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
    };
  }

  /**
   * The per-minute due reminder job (FR-NOT-2, AC-7.1). A user is due when their local time
   * has reached `prefs.reminderTime` within the grace window (`dueSlot`) and today's
   * `job_run` claim is still free. The claim is taken even when nothing is due, so a task
   * added later that morning does not trigger a late reminder. Resolves after the sends.
   */
  async runDueReminders(): Promise<number> {
    const now = this.deps.clock();
    const due = immediate(this.deps.db, (tx) => {
      const out: { recipient: Recipient; payload: PushPayload; rows: SubscriptionRef[] }[] = [];
      for (const recipient of recipientsWithPref(tx, 'due_reminder', 'push')) {
        const rows = this.subscriptionsOf(tx, recipient.id);
        if (rows.length === 0) continue;
        try {
          const slot = dueSlot(now, recipient.timezone, recipient.prefs.reminderTime);
          if (slot === null) continue;
          if (!claimJobRun(tx, DUE_REMINDER_JOB, jobScope(recipient.id, slot.date), now)) continue;
          const tasks = tasksDueByToday(
            tx,
            recipient.id,
            dueContext(recipient.timezone, now, slot.date),
          );
          if (tasks.length === 0) continue;
          const t = mailT(recipient.locale);
          const titles = tasks.slice(0, REMINDER_TITLES).map((task) => task.title);
          const rest = tasks.length - titles.length;
          const org = todayOrg(tx, recipient.id, tasks);
          out.push({
            recipient,
            rows,
            payload: {
              kind: 'due_reminder',
              title: t('push.reminder', { count: tasks.length }),
              body: [
                ...titles,
                ...(rest > 0 ? [t('push.reminderMore', { count: rest })] : []),
              ].join('\n'),
              url: org === null ? '/' : `/o/${org.slug}/today`,
              tag: 'due_reminder',
            },
          });
        } catch (err) {
          // One user's bad timezone must not stop everyone else's reminder.
          this.deps.logger.warn(
            { err: logSafeError(err), userId: recipient.id },
            'due reminder skipped',
          );
        }
      }
      return out;
    });
    await Promise.all(
      due.flatMap(({ rows, payload }) =>
        rows.map((row) => this.queue.run('push-reminder', () => this.deliver(row, payload))),
      ),
    );
    return due.length;
  }
}
