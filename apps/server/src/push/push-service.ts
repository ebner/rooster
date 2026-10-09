import { uuidv7 } from '@rooster/core/ids';
import { isAllowedPushEndpoint } from '@rooster/core/push-hosts';
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
import {
  generateVapidKeys,
  type PushSender,
  type PushSendOptions,
  pushStatusOf,
} from './transport.ts';
import { ensureVapidKeys, type VapidKeys, writeKeys } from './vapid.ts';

type SubscriptionRow = typeof pushSubscription.$inferSelect;

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
   * Upserts by endpoint (ADR 0033): re-subscribing a browser updates its keys and owner, so a
   * shared computer's subscription follows whoever signed in last.
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
    const t = mailT(recipient?.locale ?? 'en');
    const outcome = await this.queue.run('push-test', () =>
      this.deliver(row, {
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
    const payload: PushPayload = {
      kind: 'notification',
      title: described.event,
      body:
        described.quote === undefined
          ? described.subject
          : `${described.subject}\n${described.quote}`,
      url: described.path,
      tag:
        loaded.notification.taskId === null
          ? `notification:${id}`
          : `task:${loaded.notification.taskId}`,
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

  private subscriptionsOf(tx: Tx, userId: string): SubscriptionRow[] {
    return tx
      .select()
      .from(pushSubscription)
      .where(eq(pushSubscription.userId, userId))
      .orderBy(asc(pushSubscription.createdAt))
      .all();
  }

  /**
   * One message to one device. The endpoint is checked again right before sending (rows
   * written before the check existed, or by a future code path, must never reach an internal
   * host; 04 §4.11): a failing one is deleted unsent. 404 and 410 delete the subscription;
   * other failures are logged and never thrown.
   */
  private async deliver(row: SubscriptionRow, payload: PushPayload): Promise<Outcome> {
    const log = this.deps.logger.child({ subscription: row.id, kind: payload.kind });
    if (!isAllowedPushEndpoint(row.endpoint)) {
      this.remove(row.id);
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
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        JSON.stringify(message),
        { ...DELIVERY[payload.kind], vapid: this.vapid() },
      );
    } catch (err) {
      const status = pushStatusOf(err);
      if (status === 404 || status === 410) {
        this.remove(row.id);
        log.info({ status }, 'push subscription expired; deleted');
        return 'gone';
      }
      log.warn({ err: logSafeError(err), status }, 'push failed');
      return 'failed';
    }
    immediate(this.deps.db, (tx) => {
      tx.update(pushSubscription)
        .set({ lastOkAt: this.deps.clock() })
        .where(eq(pushSubscription.id, row.id))
        .run();
    });
    return 'ok';
  }

  private remove(id: string): void {
    immediate(this.deps.db, (tx) => {
      tx.delete(pushSubscription).where(eq(pushSubscription.id, id)).run();
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
      const out: { recipient: Recipient; payload: PushPayload; rows: SubscriptionRow[] }[] = [];
      for (const recipient of recipientsWithPref(tx, 'due_reminder', 'push')) {
        const rows = this.subscriptionsOf(tx, recipient.id);
        if (rows.length === 0) continue;
        try {
          const slot = dueSlot(now, recipient.timezone, recipient.prefs.reminderTime);
          if (slot === null) continue;
          if (!claimJobRun(tx, DUE_REMINDER_JOB, jobScope(recipient.id, slot.date), now)) continue;
          const tasks = tasksDueByToday(tx, recipient.id, dueContext(recipient.timezone, now));
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
