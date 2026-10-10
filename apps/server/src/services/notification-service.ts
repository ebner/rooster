import { uuidv7 } from '@rooster/core/ids';
import {
  type Notification,
  type NotificationMark,
  type NotificationMarkResult,
  type NotificationPage,
  type NotificationPrefs,
  type NotificationPrefsPut,
  type NotificationQuery,
  type NotificationType,
  PAGE_LIMIT_DEFAULT,
  type SseNotification,
} from '@rooster/core/schemas';
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { notification, organization, task, user } from '../db/schema/index.ts';
import type { DirectMessage } from '../events/bus.ts';
import {
  type Actor,
  afterCommit,
  emitAfterCommit,
  immediate,
  readOnly,
  type ServiceDeps,
  type Tx,
} from './context.ts';
import { decodeCursor, encodeCursor, isTimeIdCursor } from './cursor.ts';
import { qk, selfAudience } from './event-audience.ts';
import {
  canReadNotification,
  reachedOrgIds,
  requireBrowserSession,
  requireScope,
} from './grant-access.ts';
import { isMember } from './list-access.ts';
import type { MemberRemovalStep } from './org-service.ts';
import { prefEnabled, prefMatrix, setPref } from './pref-store.ts';

/** Read notifications are kept for 90 days (05 §4.5). */
export const READ_NOTIFICATION_RETENTION_MS = 90 * 86_400_000;

type DueSnapshot = Notification['data']['from'];

/** P10: the task's due unit when a reminder fired, for the push and email text. */
export interface ReminderDueSnapshot {
  dueDate: string;
  dueTime: string | null;
  dueTz: string | null;
}

/** What a service asks to be notified; recipients are filtered by `notify`. */
export interface NotificationDraft {
  userId: string;
  orgId: string;
  type: NotificationType;
  taskId: string | null;
  /** Null for system work. The actor is never notified of their own action. */
  actorId: string | null;
  data?: {
    commentId?: string;
    excerpt?: string;
    from?: DueSnapshot;
    to?: DueSnapshot;
    userId?: string;
    /** P10 reminder (FR-REM-3): the reminder, when it was due to fire, and whether it is late. */
    reminderId?: string;
    fireAt?: number;
    late?: boolean;
    /** P10 reminder: the due unit when it fired (stored only, for push and email). */
    due?: ReminderDueSnapshot | null;
  };
}

/**
 * `notification.data` as stored: the DTO's `data` plus the snapshot the `/inbox` shows
 * (05 §3 has no columns for them): the actor's name and image and the task's title and
 * number when the notification was created.
 */
export interface StoredData {
  commentId?: string;
  excerpt?: string;
  from?: DueSnapshot;
  to?: DueSnapshot;
  userId?: string;
  reminderId?: string;
  fireAt?: number;
  late?: boolean;
  due?: ReminderDueSnapshot | null;
  actorName?: string;
  actorImage?: string | null;
  taskTitle?: string;
  taskSeq?: number | null;
  /**
   * P7: the recipient switched the type off in-app but wants it by push or email. The row
   * exists for delivery only; the inbox and the unread count leave it out.
   */
  hidden?: true;
  /** P7: waiting for an email (the batch job's queue, `notification_email_pending`). */
  emailPending?: true;
}

/**
 * Push and email (Phase 7), as seen from the fan-out: which channels can reach a recipient,
 * and the hand-off after commit.
 */
export interface NotificationDelivery {
  /** Inside the fan-out transaction. */
  channels(tx: Tx, userId: string, type: NotificationType): { push: boolean; email: boolean };
  /** After commit, with the new notifications that want push or email. */
  dispatch(items: readonly { id: string; push: boolean; email: boolean }[]): void;
}

type NotificationRow = typeof notification.$inferSelect;

/** Plain-text comment excerpts in notifications are cut at this many characters. */
export const EXCERPT_MAX = 200;

export function parseStoredData(text: string): StoredData {
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === 'object' ? (value as StoredData) : {};
  } catch {
    return {};
  }
}

function toNotificationDto(row: NotificationRow, orgSlug: string): Notification {
  const stored = parseStoredData(row.data);
  const data: Notification['data'] = {};
  if (stored.commentId !== undefined) data.commentId = stored.commentId;
  if (stored.excerpt !== undefined) data.excerpt = stored.excerpt;
  if (stored.from !== undefined) data.from = stored.from;
  if (stored.to !== undefined) data.to = stored.to;
  if (stored.userId !== undefined) data.userId = stored.userId;
  if (stored.reminderId !== undefined) data.reminderId = stored.reminderId;
  if (stored.fireAt !== undefined) data.fireAt = stored.fireAt;
  if (stored.late !== undefined) data.late = stored.late;
  return {
    id: row.id,
    orgId: row.orgId,
    orgSlug,
    type: row.type as NotificationType,
    task:
      row.taskId === null
        ? null
        : { id: row.taskId, seq: stored.taskSeq ?? null, title: stored.taskTitle ?? '' },
    actor:
      row.actorId === null
        ? null
        : { id: row.actorId, name: stored.actorName ?? '', image: stored.actorImage ?? null },
    data,
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}

/** Rows of live orgs only: a deleted org's notifications drop out of the inbox and count. */
const liveOrg = isNull(organization.deletedAt);
/** IDs per UPDATE when a grant marks notifications (SQLite caps bound parameters). */
const MARK_CHUNK = 500;

/** Rows that exist only for push or email delivery are not in the inbox. */
const inInbox = sql`json_extract(${notification.data}, '$.hidden') IS NULL`;

/** Notifications, their fan-out to every channel, and the preference matrix (FR-NOT-1–4). */
export class NotificationService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly delivery: NotificationDelivery | null = null,
  ) {}

  /**
   * Fan-out inside the caller's transaction. Drafts addressed to the actor or to non-members
   * of the org are dropped (a `reminder` has no actor: it is the one notification about the
   * user's own doing, FR-REM-3), and so are recipients no enabled channel reaches. A recipient
   * with the type off in-app but on for push or email gets a hidden row (read, outside the
   * inbox). After commit each in-app recipient gets an `['notifications']` invalidation and
   * an SSE `notification` event with the unread count and a preview, and push and email take
   * over (`NotificationDelivery.dispatch`).
   */
  notify(tx: Tx, drafts: readonly NotificationDraft[]): void {
    const now = this.deps.clock();
    const created = new Map<string, { row: NotificationRow; preview: SseNotification }[]>();
    const outbound: { id: string; push: boolean; email: boolean }[] = [];
    for (const draft of drafts) {
      if (draft.userId === draft.actorId) continue;
      if (!isMember(tx, draft.userId, draft.orgId)) continue;
      const inapp = prefEnabled(tx, draft.userId, draft.type, 'inapp');
      const reach = this.delivery?.channels(tx, draft.userId, draft.type) ?? {
        push: false,
        email: false,
      };
      if (!inapp && !reach.push && !reach.email) continue;
      const stored: StoredData = { ...draft.data };
      if (!inapp) stored.hidden = true;
      if (reach.email) stored.emailPending = true;
      let actorName: string | null = null;
      if (draft.actorId !== null) {
        const actor = tx
          .select({ name: user.name, image: user.image })
          .from(user)
          .where(eq(user.id, draft.actorId))
          .get();
        actorName = actor?.name ?? '';
        stored.actorName = actorName;
        stored.actorImage = actor?.image ?? null;
      }
      let title: string | null = null;
      if (draft.taskId !== null) {
        const target = tx
          .select({ title: task.title, seq: task.seq })
          .from(task)
          .where(eq(task.id, draft.taskId))
          .get();
        title = target?.title ?? '';
        stored.taskTitle = title;
        stored.taskSeq = target?.seq ?? null;
      }
      const row: NotificationRow = {
        id: uuidv7(),
        userId: draft.userId,
        orgId: draft.orgId,
        type: draft.type,
        taskId: draft.taskId,
        actorId: draft.actorId,
        data: JSON.stringify(stored),
        readAt: inapp ? null : now,
        emailedAt: null,
        pushedAt: null,
        createdAt: now,
      };
      tx.insert(notification).values(row).run();
      if (reach.push || reach.email) outbound.push({ id: row.id, ...reach });
      if (!inapp) continue;
      const list = created.get(draft.userId) ?? [];
      list.push({
        row,
        preview: {
          unreadCount: 0,
          notification: {
            id: row.id,
            orgId: row.orgId,
            type: row.type,
            taskId: row.taskId,
            actorName,
            title,
          },
        },
      });
      created.set(draft.userId, list);
    }
    for (const [userId, items] of created) {
      const unreadCount = this.unreadCount(tx, userId);
      const first = items[0]?.row;
      emitAfterCommit(this.deps, tx, {
        type: 'notification.created',
        orgId: first?.orgId ?? null,
        actorId: first?.actorId ?? null,
        subjects: items.map((i) => i.row.id),
        audiences: [selfAudience(userId, null, [qk.notifications])],
        direct: items.map(
          (i): DirectMessage => ({
            userId,
            event: 'notification',
            data: { ...i.preview, unreadCount },
          }),
        ),
      });
    }
    const { delivery } = this;
    if (delivery !== null && outbound.length > 0) {
      afterCommit(tx, () => delivery.dispatch(outbound));
    }
  }

  /** Users holding notifications about `taskIds` (before a hard delete cascades them away). */
  recipientsOf(tx: Tx, taskIds: readonly string[]): string[] {
    const out = new Set<string>();
    for (let i = 0; i < taskIds.length; i += 500) {
      for (const r of tx
        .select({ userId: notification.userId })
        .from(notification)
        .where(inArray(notification.taskId, taskIds.slice(i, i + 500)))
        .all()) {
        out.add(r.userId);
      }
    }
    return [...out];
  }

  /**
   * After notifications went with their tasks (permanent delete): the recipients' inboxes and
   * badges refresh once `tx` commits.
   */
  announceRemoved(tx: Tx, userIds: readonly string[], actorId: string | null): void {
    if (userIds.length === 0) return;
    emitAfterCommit(this.deps, tx, {
      type: 'notification.read',
      orgId: null,
      actorId,
      subjects: [],
      audiences: userIds.map((userId) => selfAudience(userId, null, [qk.notifications])),
      direct: userIds.map(
        (userId): DirectMessage => ({
          userId,
          event: 'notification',
          data: { unreadCount: this.unreadCount(tx, userId), notification: null },
        }),
      ),
    });
  }

  /**
   * The user's unread notifications across their live orgs (the bell badge); with `orgIds`,
   * only in those orgs.
   */
  unreadCount(tx: Tx, userId: string, orgIds?: readonly string[]): number {
    if (orgIds !== undefined && orgIds.length === 0) return 0;
    return (
      tx
        .select({ n: sql<number>`count(*)` })
        .from(notification)
        .innerJoin(organization, eq(organization.id, notification.orgId))
        .where(
          and(
            eq(notification.userId, userId),
            isNull(notification.readAt),
            liveOrg,
            inInbox,
            orgIds === undefined ? undefined : inArray(notification.orgId, [...orgIds]),
          ),
        )
        .get()?.n ?? 0
    );
  }

  /**
   * The bell badge as the actor may see it: a grant counts only notifications it may read
   * (its orgs, and tasks its read constraint shows).
   */
  unreadCountFor(actor: Actor, tx?: Tx): number {
    const count = (t: Tx) => {
      if (actor.grant === null) return this.unreadCount(t, actor.userId);
      const orgIds = reachedOrgIds(actor);
      if (orgIds !== undefined && orgIds.length === 0) return 0;
      return t
        .select({ orgId: notification.orgId, taskId: notification.taskId })
        .from(notification)
        .innerJoin(organization, eq(organization.id, notification.orgId))
        .where(
          and(
            eq(notification.userId, actor.userId),
            isNull(notification.readAt),
            liveOrg,
            inInbox,
            orgIds === undefined ? undefined : inArray(notification.orgId, [...orgIds]),
          ),
        )
        .all()
        .filter((n) => canReadNotification(t, actor, n)).length;
    };
    return tx === undefined ? readOnly(this.deps.db, count) : count(tx);
  }

  /** GET /notifications: newest first, cursor paged, with the unread count. */
  list(actor: Actor, query: NotificationQuery): NotificationPage {
    requireScope(actor, 'notifications:read');
    return readOnly(this.deps.db, (tx) => {
      const limit = query.limit ?? PAGE_LIMIT_DEFAULT;
      const after = decodeCursor(query.cursor, isTimeIdCursor);
      const rows = tx
        .select({ row: notification, slug: organization.slug })
        .from(notification)
        .innerJoin(organization, eq(organization.id, notification.orgId))
        .where(
          and(
            eq(notification.userId, actor.userId),
            liveOrg,
            inInbox,
            query.unread === 'true' ? isNull(notification.readAt) : undefined,
            after === null
              ? undefined
              : or(
                  lt(notification.createdAt, after[0]),
                  and(eq(notification.createdAt, after[0]), lt(notification.id, after[1])),
                ),
          ),
        )
        .orderBy(desc(notification.createdAt), desc(notification.id))
        .limit(limit + 1)
        .all();
      const page = rows.slice(0, limit);
      const last = page[page.length - 1]?.row;
      return {
        // A grant sees only what it may read: its orgs, and tasks its constraints show.
        items: page
          .filter((r) => canReadNotification(tx, actor, r.row))
          .map((r) => toNotificationDto(r.row, r.slug)),
        nextCursor:
          rows.length > limit && last !== undefined
            ? encodeCursor([last.createdAt, last.id])
            : null,
        unreadCount: this.unreadCountFor(actor, tx),
      };
    });
  }

  /**
   * POST /notifications/read (`read`) and /notifications/unread. Unknown IDs and other users'
   * notifications are ignored. When anything changed, every stream of the user gets the new
   * count (a count-only `notification` event) and an `['notifications']` invalidation.
   */
  mark(actor: Actor, input: NotificationMark, read: boolean): NotificationMarkResult {
    requireScope(actor, 'notifications:read');
    return immediate(this.deps.db, (tx) => {
      const requested = 'ids' in input ? [...new Set(input.ids)] : null;
      const readAt = read ? this.deps.clock() : null;
      const pending = read ? isNull(notification.readAt) : isNotNull(notification.readAt);
      let changed = 0;
      if (actor.grant === null) {
        changed = tx
          .update(notification)
          .set({ readAt })
          .where(
            and(
              eq(notification.userId, actor.userId),
              inInbox,
              requested === null ? undefined : inArray(notification.id, requested),
              pending,
            ),
          )
          .run().changes;
      } else {
        // A grant marks only notifications it may read, also for `{all: true}`. Readability
        // is decided per row, so the update runs over the allowed IDs in bounded chunks.
        const allowed = tx
          .select({ id: notification.id, orgId: notification.orgId, taskId: notification.taskId })
          .from(notification)
          .where(
            and(
              eq(notification.userId, actor.userId),
              inInbox,
              requested === null ? undefined : inArray(notification.id, requested),
              pending,
            ),
          )
          .all()
          .filter((n) => canReadNotification(tx, actor, n))
          .map((n) => n.id);
        for (let i = 0; i < allowed.length; i += MARK_CHUNK) {
          changed += tx
            .update(notification)
            .set({ readAt })
            .where(
              and(
                eq(notification.userId, actor.userId),
                inArray(notification.id, allowed.slice(i, i + MARK_CHUNK)),
                pending,
              ),
            )
            .run().changes;
        }
      }
      const ids = requested;
      const unreadCount = this.unreadCountFor(actor, tx);
      if (changed > 0) {
        // Every stream gets the user's whole count; a grant's stream rewrites it to its own
        // (GrantService.streamAccess).
        const data: SseNotification = {
          unreadCount: this.unreadCount(tx, actor.userId),
          notification: null,
        };
        emitAfterCommit(this.deps, tx, {
          type: 'notification.read',
          orgId: null,
          actorId: actor.userId,
          subjects: ids ?? [],
          audiences: [selfAudience(actor.userId, null, [qk.notifications])],
          direct: [{ userId: actor.userId, event: 'notification', data }],
        });
      }
      return { unreadCount };
    });
  }

  /** GET /me/notification-prefs: all 20 cells, defaults applied (ADR 0033). */
  getPrefs(actor: Actor): NotificationPrefs {
    requireBrowserSession(actor);
    return readOnly(this.deps.db, (tx) => ({ prefs: prefMatrix(tx, actor.userId) }));
  }

  /**
   * PUT /me/notification-prefs: sets the given cells (the schema rejects cells that do not
   * exist). A row is stored only for a cell the user set; the rest follow the defaults.
   */
  putPrefs(actor: Actor, input: NotificationPrefsPut): NotificationPrefs {
    requireBrowserSession(actor);
    return immediate(this.deps.db, (tx) => {
      for (const p of input.prefs) setPref(tx, actor.userId, p.type, p.channel, p.enabled);
      return { prefs: prefMatrix(tx, actor.userId) };
    });
  }

  /** `invite_accepted` (FR-NOT-1) to whoever created the invite, when someone joins by it. */
  inviteAccepted(tx: Tx, input: { orgId: string; userId: string; inviterId: string }): void {
    this.notify(tx, [
      {
        userId: input.inviterId,
        orgId: input.orgId,
        type: 'invite_accepted',
        taskId: null,
        actorId: input.userId,
        data: { userId: input.userId },
      },
    ]);
  }

  /** Retention (05 §4.5): read notifications created more than 90 days ago. */
  purgeRead(tx: Tx, now: number): number {
    return tx
      .delete(notification)
      .where(
        and(
          isNotNull(notification.readAt),
          lt(notification.createdAt, now - READ_NOTIFICATION_RETENTION_MS),
        ),
      )
      .run().changes;
  }

  /** Member removal (05 §4.2): the leaving member's notifications from that org go. */
  readonly memberRemovalStep: MemberRemovalStep = (tx, { orgId, userId }) => {
    tx.delete(notification)
      .where(and(eq(notification.userId, userId), eq(notification.orgId, orgId)))
      .run();
  };
}
