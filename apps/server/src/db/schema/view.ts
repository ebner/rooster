import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { user } from './auth.ts';
import { organization } from './org.ts';

/**
 * Phase 13 (05 §3, ADR 0073 B): views, saved queries in one org. `query` is JSON validated by
 * core's `savedViewQuerySchema`; `shared` is always false in a personal org. A member removal
 * deletes their private views (`viewRemovalStep`); shared ones keep `created_by`.
 */
export const savedView = sqliteTable(
  'saved_view',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id),
    shared: integer('shared', { mode: 'boolean' }).notNull().default(false),
    name: text('name').notNull(),
    query: text('query').notNull(),
    archivedAt: integer('archived_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('saved_view_org').on(t.orgId, t.createdBy),
    check('saved_view_name', sql`length(name) BETWEEN 1 AND 60`),
  ],
);

/** Each member's own sidebar order of the views they see (fractional keys). */
export const savedViewPref = sqliteTable(
  'saved_view_pref',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    viewId: text('view_id')
      .notNull()
      .references(() => savedView.id, { onDelete: 'cascade' }),
    position: text('position').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.viewId] }),
    index('saved_view_pref_view').on(t.viewId),
  ],
);
