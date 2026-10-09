import { z } from 'zod';
import { COMMENT_BODY_MAX } from '../limits.ts';
import {
  isPrefCell,
  NOTIFICATION_PREF_CELLS,
  NOTIFICATION_PREF_TYPES,
} from '../notification-prefs.ts';
import { idSchema, isoDateSchema, timeSchema, timestampSchema } from './common.ts';
import { pageQuerySchema } from './task-query.ts';

/**
 * Phase 6 collaboration contract (01 FR-COL/FR-NOT-1, 05 §3 `comment`/`activity`/`follower`/
 * `notification`, 06 §2.6). DTOs are additive-only within API v1.
 *
 * Mentions are stored inside comment bodies as `@[Name](user:<id>)` (`@rooster/core/mentions`).
 */

export { COMMENT_BODY_MAX } from '../limits.ts';

// ---------------------------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------------------------

/** Markdown-light (bold, italic, code, links, lists) plus mentions; never raw HTML. */
export const commentBodySchema = z
  .string()
  .max(COMMENT_BODY_MAX)
  .refine((s) => s.trim().length > 0, { error: 'Comment is empty' });

export const commentSchema = z.object({
  id: idSchema,
  taskId: idSchema,
  authorId: idSchema,
  body: z.string(),
  createdAt: timestampSchema,
  /** Set when the author edited the body ("edited" label, FR-COL-3). */
  editedAt: timestampSchema.nullable(),
});

/** POST /tasks/:id/comments. The client supplies `id` (UUIDv7) so the outbox can replay it. */
export const commentCreateSchema = z.object({
  id: idSchema.optional(),
  body: commentBodySchema,
});

/** PATCH /comments/:id (author only). */
export const commentPatchSchema = z.object({ body: commentBodySchema });

// ---------------------------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------------------------

/** `X-Rooster-Client` kind recorded on every activity entry (06 §1). */
export const ACTIVITY_VIA = ['web', 'pwa', 'cli', 'tui', 'mcp', 'pat', 'import', 'system'] as const;
export const activityViaSchema = z.enum(ACTIVITY_VIA);

const dueSnapshotSchema = z
  .object({ dueDate: isoDateSchema.nullable(), dueTime: timeSchema.nullable() })
  .nullable();

const activityBase = {
  id: idSchema,
  taskId: idSchema,
  /** Null for system work (jobs, member removal). */
  actorId: idSchema.nullable(),
  via: activityViaSchema,
  createdAt: timestampSchema,
};

/**
 * One activity entry (FR-COL-5). `data` is typed per `type`; the server stores it as JSON in
 * `activity.data` together with `via`.
 */
export const activitySchema = z.discriminatedUnion('type', [
  z.object({ ...activityBase, type: z.literal('created'), data: z.object({}) }),
  z.object({
    ...activityBase,
    type: z.literal('renamed'),
    data: z.object({ from: z.string(), to: z.string() }),
  }),
  z.object({
    ...activityBase,
    type: z.literal('due_changed'),
    data: z.object({ from: dueSnapshotSchema, to: dueSnapshotSchema }),
  }),
  z.object({
    ...activityBase,
    type: z.literal('assigned'),
    data: z.object({ from: idSchema.nullable(), to: idSchema.nullable() }),
  }),
  z.object({ ...activityBase, type: z.literal('completed'), data: z.object({}) }),
  z.object({ ...activityBase, type: z.literal('reopened'), data: z.object({}) }),
  z.object({ ...activityBase, type: z.literal('description_edited'), data: z.object({}) }),
  z.object({
    ...activityBase,
    type: z.literal('subtask_added'),
    data: z.object({ subtaskId: idSchema, title: z.string() }),
  }),
  z.object({
    ...activityBase,
    type: z.literal('moved_parent'),
    data: z.object({ from: idSchema.nullable(), to: idSchema.nullable() }),
  }),
  z.object({ ...activityBase, type: z.literal('restored'), data: z.object({}) }),
  /** P10. */
  z.object({
    ...activityBase,
    type: z.literal('attachment_added'),
    data: z.object({ attachmentId: idSchema, filename: z.string() }),
  }),
]);

export const ACTIVITY_TYPES = [
  'created',
  'renamed',
  'due_changed',
  'assigned',
  'completed',
  'reopened',
  'description_edited',
  'subtask_added',
  'moved_parent',
  'restored',
  'attachment_added',
] as const;
export const activityTypeSchema = z.enum(ACTIVITY_TYPES);

export const activityItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('comment'), comment: commentSchema }),
  z.object({ kind: z.literal('activity'), activity: activitySchema }),
]);

export const activityFilterSchema = z.enum(['all', 'comments']);

/** GET /tasks/:id/activity. Pages go back in time; `cursor` continues with OLDER items. */
export const activityQuerySchema = pageQuerySchema.extend({
  filter: activityFilterSchema.optional(),
});

/** `items` are oldest first (newest last, 06 §2.6) within the page. */
export const activityPageSchema = z.object({
  items: z.array(activityItemSchema),
  /** Continues with older items; null when the feed's start is reached. */
  nextCursor: z.string().nullable(),
});

// ---------------------------------------------------------------------------------------------
// Followers
// ---------------------------------------------------------------------------------------------

/** Response of PUT/DELETE /tasks/:id/followers/me: the task's active (unmuted) followers. */
export const followStateSchema = z.object({ followers: z.array(idSchema) });

// ---------------------------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------------------------

export const NOTIFICATION_TYPES = [
  'assigned',
  'comment',
  'mention',
  'completed',
  'due_changed',
  'invite_accepted',
] as const;
export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);

export const NOTIFICATION_CHANNELS = ['inapp', 'push', 'email'] as const;
export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);

/**
 * One in-app notification (FR-NOT-1). Denormalised for the cross-org `/inbox`: the actor's
 * name and the task title are as of when the notification was created; `orgSlug` is current.
 */
export const notificationSchema = z.object({
  id: idSchema,
  orgId: idSchema,
  orgSlug: z.string(),
  type: notificationTypeSchema,
  task: z
    .object({ id: idSchema, seq: z.int().positive().nullable(), title: z.string() })
    .nullable(),
  actor: z.object({ id: idSchema, name: z.string(), image: z.string().nullable() }).nullable(),
  data: z.object({
    /** comment, mention: the comment, with a plain-text excerpt (mentions as `@Name`). */
    commentId: idSchema.optional(),
    excerpt: z.string().optional(),
    /** due_changed. */
    from: dueSnapshotSchema.optional(),
    to: dueSnapshotSchema.optional(),
    /** invite_accepted: the member who joined. */
    userId: idSchema.optional(),
  }),
  readAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
});

export const notificationQuerySchema = pageQuerySchema.extend({
  /** `true`: unread only. */
  unread: z.enum(['true', 'false']).optional(),
});

/** GET /notifications: newest first. */
export const notificationPageSchema = z.object({
  items: z.array(notificationSchema),
  nextCursor: z.string().nullable(),
  /** All of the user's unread notifications, across orgs (the bell badge). */
  unreadCount: z.int().nonnegative(),
});

/** POST /notifications/read and /notifications/unread: exactly one of the two. */
export const notificationMarkSchema = z.union([
  z.object({ ids: z.array(idSchema).min(1).max(200) }),
  z.object({ all: z.literal(true) }),
]);
export const notificationMarkResultSchema = z.object({ unreadCount: z.int().nonnegative() });

/** P7: the matrix rows are the events plus `digest` (email) and `due_reminder` (push). */
export const notificationPrefTypeSchema = z.enum(NOTIFICATION_PREF_TYPES);

export const notificationPrefSchema = z
  .object({
    type: notificationPrefTypeSchema,
    channel: notificationChannelSchema,
    enabled: z.boolean(),
  })
  .refine((cell) => isPrefCell(cell.type, cell.channel), {
    error: 'No such cell (the digest is email only, the due reminder push only)',
    path: ['channel'],
  });

/**
 * GET/PUT /me/notification-prefs: the event × channel matrix (FR-NOT-4). GET returns every
 * cell (`NOTIFICATION_PREF_CELLS`) with defaults applied (`defaultPrefEnabled`, ADR 0033);
 * PUT takes any subset of cells. Reminder and digest times and the email mode live in `/me`
 * prefs.
 */
export const notificationPrefsSchema = z.object({ prefs: z.array(notificationPrefSchema) });
export const notificationPrefsPutSchema = z.object({
  prefs: z.array(notificationPrefSchema).min(1).max(NOTIFICATION_PREF_CELLS.length),
});

export type CommentBody = z.infer<typeof commentBodySchema>;
export type Comment = z.infer<typeof commentSchema>;
export type CommentCreate = z.infer<typeof commentCreateSchema>;
export type CommentPatch = z.infer<typeof commentPatchSchema>;
export type ActivityVia = z.infer<typeof activityViaSchema>;
export type Activity = z.infer<typeof activitySchema>;
export type ActivityType = z.infer<typeof activityTypeSchema>;
export type ActivityItem = z.infer<typeof activityItemSchema>;
export type ActivityFilter = z.infer<typeof activityFilterSchema>;
export type ActivityQuery = z.infer<typeof activityQuerySchema>;
export type ActivityPage = z.infer<typeof activityPageSchema>;
export type FollowState = z.infer<typeof followStateSchema>;
export type NotificationType = z.infer<typeof notificationTypeSchema>;
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;
export type Notification = z.infer<typeof notificationSchema>;
export type NotificationQuery = z.infer<typeof notificationQuerySchema>;
export type NotificationPage = z.infer<typeof notificationPageSchema>;
export type NotificationMark = z.infer<typeof notificationMarkSchema>;
export type NotificationMarkResult = z.infer<typeof notificationMarkResultSchema>;
export type NotificationPrefTypeValue = z.infer<typeof notificationPrefTypeSchema>;
export type NotificationPref = z.infer<typeof notificationPrefSchema>;
export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>;
export type NotificationPrefsPut = z.infer<typeof notificationPrefsPutSchema>;
