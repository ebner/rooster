import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Stored mutation responses keyed by `Idempotency-Key` (04 §6.2), kept for 7 days. */
export const idempotency = sqliteTable(
  'idempotency',
  {
    opId: text('op_id').notNull(),
    userId: text('user_id').notNull(),
    status: integer('status').notNull(),
    /** The stored response, see lib/idempotency.ts for the envelope. */
    response: text('response').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.opId, t.userId] })],
);
