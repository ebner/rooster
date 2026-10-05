import { sql } from 'drizzle-orm';
import { check, customType, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { user } from './auth.ts';

/** TEXT compared case-insensitively (05 §3: `value TEXT NOT NULL COLLATE NOCASE UNIQUE`). */
const nocaseText = customType<{ data: string }>({
  dataType: () => 'text COLLATE NOCASE',
});

/** Admin-managed sign-in allowlist, in addition to ROOSTER_ALLOWED_EMAILS / _DOMAINS. */
export const allowlistEntry = sqliteTable(
  'allowlist_entry',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['email', 'domain'] }).notNull(),
    value: nocaseText('value').notNull().unique(),
    createdBy: text('created_by').references(() => user.id),
    createdAt: integer('created_at').notNull(),
  },
  () => [check('allowlist_entry_kind', sql`kind IN ('email','domain')`)],
);
