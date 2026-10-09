import { uuidv7 } from '@rooster/core/ids';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_TYPES,
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
import { notification, notificationPref, organization, task, user } from '../db/schema/index.ts';
import type { DirectMessage } from '../events/bus.ts';
import { AppError } from '../lib/errors.ts';
import {
  type Actor,
  emitAfterCommit,
  immediate,
  readOnly,
  type ServiceDeps,
  type Tx,
} from './context.ts';
import { decodeCursor, encodeCursor, isTimeIdCursor } from './cursor.ts';
import { qk, selfAudience } from './event-audience.ts';
import { isMember } from './list-access.ts';
import type { MemberRemovalStep } from './org-service.ts';

/** Read notifications are kept for 90 days (05 §4.5). */
export const READ_NOTIFICATION_RETENTION_MS = 90 * 86_400_000;

type DueSnapshot = Notification['data']['from'];

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
  };
}

/**
 * `notification.data` as stored: the DTO's `data` plus the snapshot the `/inbox` shows
 * (05 §3 has no columns for them): the actor's name and image and the task's title and
 * number when the notification was created.
 */
interface StoredData {
  commentId?: string;
  excerpt?: string;
  from?: DueSnapshot;
  to?: DueSnapshot;
  userId?: string;
  actorName?: string;
  actorImage?: string | null;
  taskTitle?: string;
  taskSeq?: number | null;
}

type NotificationRow = typeof notification.$inferSelect;

/** Plain-text comment excerpts in notifications are cut at this many characters. */
export const EXCERPT_MAX = 200;

function parseData(text: string): StoredData {
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === 'object' ? (value as StoredData) : {};
  } catch {
    return {};
  }
}

function toNotificationDto(row: NotificationRow, orgSlug: string): Notification {
  const stored = parseData(row.data);
  const data: Notification['data'] = {};
  if (stored.commentId !== undefined) data.commentId = stored.commentId;
  if (stored.excerpt !== undefined) data.excerpt = stored.excerpt;
  if (stored.from !== undefined) data.from = stored.from;
  if (stored.to !== undefined) data.to = stored.to;
  if (stored.userId !== undefined) data.userId = stored.userId;
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

/** In-app notifications and the preference matrix (FR-NOT-1, FR-NOT-4). */
export class NotificationService {
  constructor(private readonly deps: ServiceDeps) {}

  /**
   * Fan-out inside the caller's transaction. Drafts addressed to the actor, to non-members
   * of the org, or to users who switched the type off in-app are dropped. After commit each
   * recipient gets an `['notifications']` invalidation and an SSE `notification` event with
   * the unread count and a preview.
   */
  notify(tx: Tx, drafts: readonly NotificationDraft[]): void {
    const now = this.deps.clock();
    const created = new Map<string, { row: NotificationRow; preview: SseNotification }[]>();
    for (const draft of drafts) {
      if (draft.userId === draft.actorId) continue;
      if (!isMember(tx, draft.userId, draft.orgId)) continue;
      if (!this.enabled(tx, draft.userId, draft.type, 'inapp')) continue;
      const stored: StoredData = { ...draft.data };
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
        readAt: null,
        emailedAt: null,
        pushedAt: null,
        createdAt: now,
      };
      tx.insert(notification).values(row).run();
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
  }

  private enabled(tx: Tx, userId: string, type: string, channel: string): boolean {
    const row = tx
      .select({ enabled: notificationPref.enabled })
      .from(notificationPref)
      .where(
        and(
          eq(notificationPref.userId, userId),
          eq(notificationPref.type, type),
          eq(notificationPref.channel, channel as (typeof NOTIFICATION_CHANNELS)[number]),
        ),
      )
      .get();
    return row?.enabled ?? true;
  }

  /** The user's unread notifications across their live orgs (the bell badge). */
  unreadCount(tx: Tx, userId: string): number {
    return (
      tx
        .select({ n: sql<number>`count(*)` })
        .from(notification)
        .innerJoin(organization, eq(organization.id, notification.orgId))
        .where(and(eq(notification.userId, userId), isNull(notification.readAt), liveOrg))
        .get()?.n ?? 0
    );
  }

  /** GET /notifications: newest first, cursor paged, with the unread count. */
  list(actor: Actor, query: NotificationQuery): NotificationPage {
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
        items: page.map((r) => toNotificationDto(r.row, r.slug)),
        nextCursor:
          rows.length > limit && last !== undefined
            ? encodeCursor([last.createdAt, last.id])
            : null,
        unreadCount: this.unreadCount(tx, actor.userId),
      };
    });
  }

  /**
   * POST /notifications/read (`read`) and /notifications/unread. Unknown IDs and other users'
   * notifications are ignored. When anything changed, every stream of the user gets the new
   * count (a count-only `notification` event) and an `['notifications']` invalidation.
   */
  mark(actor: Actor, input: NotificationMark, read: boolean): NotificationMarkResult {
    return immediate(this.deps.db, (tx) => {
      const ids = 'ids' in input ? [...new Set(input.ids)] : null;
      const changed = tx
        .update(notification)
        .set({ readAt: read ? this.deps.clock() : null })
        .where(
          and(
            eq(notification.userId, actor.userId),
            ids === null ? undefined : inArray(notification.id, ids),
            read ? isNull(notification.readAt) : isNotNull(notification.readAt),
          ),
        )
        .run().changes;
      const unreadCount = this.unreadCount(tx, actor.userId);
      if (changed > 0) {
        const data: SseNotification = { unreadCount, notification: null };
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

  /** GET /me/notification-prefs: every type × channel cell; a cell never set is on. */
  getPrefs(actor: Actor): NotificationPrefs {
    return readOnly(this.deps.db, (tx) => this.prefsOf(tx, actor.userId));
  }

  private prefsOf(tx: Tx, userId: string): NotificationPrefs {
    const stored = new Map(
      tx
        .select()
        .from(notificationPref)
        .where(eq(notificationPref.userId, userId))
        .all()
        .map((r) => [`${r.type}/${r.channel}`, r.enabled]),
    );
    return {
      prefs: NOTIFICATION_TYPES.flatMap((type) =>
        NOTIFICATION_CHANNELS.map((channel) => ({
          type,
          channel,
          enabled: stored.get(`${type}/${channel}`) ?? true,
        })),
      ),
    };
  }

  /**
   * PUT /me/notification-prefs: sets the given cells. Phase 6 delivers in-app only, so any
   * other channel is `422 validation_failed` (until Phase 7) and nothing is written.
   */
  putPrefs(actor: Actor, input: NotificationPrefsPut): NotificationPrefs {
    return immediate(this.deps.db, (tx) => {
      const errors = input.prefs.flatMap((p, i) =>
        p.channel === 'inapp'
          ? []
          : [{ path: `prefs.${i}.channel`, message: 'Only the inapp channel is available yet' }],
      );
      if (errors.length > 0) {
        throw new AppError(
          'validation_failed',
          422,
          'Only in-app notifications can be configured.',
          errors,
        );
      }
      for (const p of input.prefs) {
        tx.insert(notificationPref)
          .values({ userId: actor.userId, type: p.type, channel: p.channel, enabled: p.enabled })
          .onConflictDoUpdate({
            target: [notificationPref.userId, notificationPref.type, notificationPref.channel],
            set: { enabled: p.enabled },
          })
          .run();
      }
      return this.prefsOf(tx, actor.userId);
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
