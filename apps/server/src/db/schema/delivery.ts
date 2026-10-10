import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { user } from './auth.ts';

// Phase 7 notification delivery tables (05 §3).

/** A browser's Web Push subscription (FR-NOT-2); upserted by `endpoint` (ADR 0033). */
export const pushSubscription = sqliteTable('push_subscription', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  userAgent: text('user_agent'),
  createdAt: integer('created_at').notNull(),
  /** The last push the push service accepted. */
  lastOkAt: integer('last_ok_at'),
  /**
   * P11: set when the server's VAPID keys were replaced after this subscription was made. It
   * cannot be sent to any more, but the browser may still renew it in place
   * (`renewsEndpoint`) when the app next opens; a device the user removed is deleted instead.
   */
  keysRotatedAt: integer('keys_rotated_at'),
});

/**
 * Scheduled sends claimed before they go out (04 §4.6): `(job, scope)` is unique, so a restart
 * or an overlapping run never sends twice. `scope` is e.g. `<userId>|<YYYY-MM-DD>`.
 */
export const jobRun = sqliteTable(
  'job_run',
  {
    job: text('job').notNull(),
    scope: text('scope').notNull(),
    ranAt: integer('ran_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.job, t.scope] })],
);
