import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { user } from './auth.ts';
import { organization } from './org.ts';
import { task } from './task.ts';

// Phase 10 tables (05 §3): task reminders, attachments and calendar feeds.

/**
 * One user's reminder on one task (FR-REM). Personal: only `user_id` sees it and is reminded.
 * `fire_at` is the resolved instant, recomputed in the same transaction as any change to the
 * task's due unit and when the owner's timezone or `allDayReminderTime` changes; NULL means
 * dormant (a relative reminder on a task without a due date). The scheduler claims a due row by
 * setting `fired_at` before it sends (ADR 0049).
 */
export const taskReminder = sqliteTable(
  'task_reminder',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['relative', 'absolute'] }).notNull(),
    offsetMinutes: integer('offset_minutes'),
    remindAt: integer('remind_at'),
    fireAt: integer('fire_at'),
    firedAt: integer('fired_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('task_reminder_due').on(t.fireAt).where(sql`fired_at IS NULL`),
    index('task_reminder_task').on(t.taskId, t.userId),
    check('task_reminder_kind', sql`kind IN ('relative','absolute')`),
    check('task_reminder_relative', sql`(kind = 'relative') = (offset_minutes IS NOT NULL)`),
    check('task_reminder_absolute', sql`(kind = 'absolute') = (remind_at IS NOT NULL)`),
    check(
      'task_reminder_offset',
      sql`offset_minutes IS NULL OR offset_minutes BETWEEN 0 AND 40320`,
    ),
  ],
);

/**
 * A file attached to a task (FR-ATT). The blob lives in the BlobStore under `key` (and the
 * WebP thumbnail under `thumb_key`); `storage` records which backend holds it, so switching
 * `ROOSTER_S3_*` later does not orphan older files. `mime` is the sniffed type.
 */
export const attachment = sqliteTable(
  'attachment',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
    orgId: text('org_id').notNull(),
    uploaderId: text('uploader_id')
      .notNull()
      .references(() => user.id),
    filename: text('filename').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    storage: text('storage', { enum: ['local', 's3'] }).notNull(),
    key: text('key').notNull(),
    thumbKey: text('thumb_key'),
    width: integer('width'),
    height: integer('height'),
    createdAt: integer('created_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [
    index('attachment_task').on(t.taskId).where(sql`deleted_at IS NULL`),
    check('attachment_storage', sql`storage IN ('local','s3')`),
  ],
);

/** A private calendar feed URL (FR-CAL); the token is stored only as its SHA-256 hash. */
export const icalFeed = sqliteTable('ical_feed', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  /** NULL = all of the user's orgs. */
  orgId: text('org_id').references(() => organization.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: integer('created_at').notNull(),
  lastUsedAt: integer('last_used_at'),
});

/**
 * Blobs to delete (ADR 0049 §3.6). A trigger on `attachment` (migration 0011) queues the keys
 * of every deleted row, whatever deleted it (a DELETE, a task purge cascading, an org deletion),
 * and the blob GC job drains the queue after commit. Keys are unique per attachment.
 */
export const blobGc = sqliteTable('blob_gc', {
  key: text('key').primaryKey(),
  storage: text('storage', { enum: ['local', 's3'] }).notNull(),
  queuedAt: integer('queued_at').notNull(),
});
