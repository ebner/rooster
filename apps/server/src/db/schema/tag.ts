import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { organization } from './org.ts';
import { task } from './task.ts';

/** Org tags (05 §3, FR-TAG-1). Names are unique per org, case-insensitively. */
export const tag = sqliteTable(
  'tag',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Tag palette name (03 §2.4). */
    color: text('color').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('tag_org_name').on(t.orgId, sql`${t.name} COLLATE NOCASE`),
    check('tag_name', sql`length(name) BETWEEN 1 AND 40`),
  ],
);

/** Tags on tasks; `added_at` (then insertion order) is the chip order (TaskDTO.tagIds). */
export const taskTag = sqliteTable(
  'task_tag',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tag.id, { onDelete: 'cascade' }),
    addedAt: integer('added_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.tagId] }), index('task_tag_tag').on(t.tagId)],
);
