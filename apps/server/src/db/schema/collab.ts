import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { user } from './auth.ts';
import { task } from './task.ts';

// Phase 6 collaboration tables (05 §3).

/** Comments (FR-COL-3). Mentions live in the body as `@[Name](user:<id>)`; soft-deleted. */
export const comment = sqliteTable(
  'comment',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
    authorId: text('author_id')
      .notNull()
      .references(() => user.id),
    body: text('body').notNull(),
    createdAt: integer('created_at').notNull(),
    editedAt: integer('edited_at'),
    deletedAt: integer('deleted_at'),
  },
  (t) => [
    index('comment_task').on(t.taskId, t.createdAt),
    check('comment_body', sql`length(body) BETWEEN 1 AND 20000`),
  ],
);

/** The activity log (FR-COL-5). `data` is the type's payload plus `via`. */
export const activity = sqliteTable(
  'activity',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
    orgId: text('org_id').notNull(),
    actorId: text('actor_id').references(() => user.id),
    type: text('type').notNull(),
    data: text('data').notNull().default('{}'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('activity_task').on(t.taskId, t.createdAt)],
);

/** Followers (FR-COL-4). An explicit unfollow keeps a muted row so auto-follow skips it. */
export const follower = sqliteTable(
  'follower',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    muted: integer('muted', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.userId] })],
);

/** In-app notifications (FR-NOT-1); `emailed_at`/`pushed_at` are for P7 delivery. */
export const notification = sqliteTable(
  'notification',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    orgId: text('org_id').notNull(),
    type: text('type').notNull(),
    taskId: text('task_id').references(() => task.id, { onDelete: 'cascade' }),
    actorId: text('actor_id').references(() => user.id),
    data: text('data').notNull().default('{}'),
    readAt: integer('read_at'),
    emailedAt: integer('emailed_at'),
    pushedAt: integer('pushed_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('notification_inbox').on(t.userId, t.readAt, sql`${t.createdAt} DESC`),
    // The email batch job's queue (P7): notifications waiting for an email.
    index('notification_email_pending')
      .on(t.userId, t.createdAt)
      .where(sql`emailed_at IS NULL AND json_extract(data, '$.emailPending') = 1`),
  ],
);

/** The event × channel preference matrix (FR-NOT-4); a missing cell has its default (ADR 0033). */
export const notificationPref = sqliteTable(
  'notification_pref',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    channel: text('channel', { enum: ['inapp', 'push', 'email'] }).notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.type, t.channel] }),
    check('notification_pref_channel', sql`channel IN ('inapp','push','email')`),
  ],
);
