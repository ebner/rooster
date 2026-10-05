import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { user } from './auth.ts';
import { organization } from './org.ts';

/** Personal groups (sections) in My tasks (05 §3). */
export const taskGroup = sqliteTable(
  'task_group',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['inbox', 'normal'] })
      .notNull()
      .default('normal'),
    name: text('name').notNull(),
    /** Ignored for the inbox, which is always first. */
    position: text('position').notNull(),
    collapsed: integer('collapsed', { mode: 'boolean' }).notNull().default(false),
    fieldClock: text('field_clock').notNull().default('{}'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [
    index('task_group_owner').on(t.userId, t.orgId, t.position).where(sql`deleted_at IS NULL`),
    uniqueIndex('task_group_one_inbox').on(t.userId, t.orgId).where(sql`kind = 'inbox'`),
    check('task_group_kind', sql`kind IN ('inbox','normal')`),
    check('task_group_name', sql`length(name) BETWEEN 1 AND 80`),
  ],
);
