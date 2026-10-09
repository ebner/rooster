import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { user } from './auth.ts';
import { organization } from './org.ts';
import { taskGroup } from './task-group.ts';

/** Tasks (05 §3). `field_clock` holds the per-field LWW clocks (05 §4.4). */
export const task = sqliteTable(
  'task',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    /** Org-scoped human number (#42), assigned on server insert. */
    seq: integer('seq'),
    parentId: text('parent_id').references((): AnySQLiteColumn => task.id, {
      onDelete: 'cascade',
    }),
    subtaskPosition: text('subtask_position'),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    assigneeId: text('assignee_id').references(() => user.id, { onDelete: 'set null' }),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id),
    dueDate: text('due_date'),
    dueTime: text('due_time'),
    dueTz: text('due_tz'),
    startDate: text('start_date'),
    recurrence: text('recurrence'),
    recurrenceBasis: text('recurrence_basis', { enum: ['due', 'completion'] }),
    seriesId: text('series_id'),
    completedAt: integer('completed_at'),
    completedBy: text('completed_by').references(() => user.id),
    fieldClock: text('field_clock').notNull().default('{}'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
    deletedBy: text('deleted_by').references(() => user.id),
  },
  (t) => [
    uniqueIndex('task_org_seq').on(t.orgId, t.seq),
    index('task_parent').on(t.parentId, t.subtaskPosition).where(sql`deleted_at IS NULL`),
    // Subtree walks that include deleted rows (grant prior groups, the readable-task CTE of
    // search) must not scan the table once per level.
    index('task_parent_any').on(t.parentId),
    index('task_assignee').on(t.orgId, t.assigneeId, t.completedAt).where(sql`deleted_at IS NULL`),
    index('task_due')
      .on(t.orgId, t.dueDate)
      .where(sql`deleted_at IS NULL AND completed_at IS NULL`),
    index('task_trash').on(t.orgId, t.deletedAt).where(sql`deleted_at IS NOT NULL`),
    check('task_title', sql`length(title) BETWEEN 1 AND 500`),
    check(
      'task_recurrence_basis',
      sql`recurrence_basis IS NULL OR recurrence_basis IN ('due','completion')`,
    ),
    check('task_due_time_needs_date', sql`due_time IS NULL OR due_date IS NOT NULL`),
    check(
      'task_start_before_due',
      sql`start_date IS NULL OR due_date IS NULL OR start_date <= due_date`,
    ),
    check('task_parent_position', sql`(parent_id IS NULL) = (subtask_position IS NULL)`),
  ],
);

/** Where a task sits in its assignee's My tasks (05 §3, invariant 05 §4.1). */
export const placement = sqliteTable(
  'placement',
  {
    taskId: text('task_id')
      .primaryKey()
      .references(() => task.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    groupId: text('group_id')
      .notNull()
      .references(() => taskGroup.id),
    position: text('position').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('placement_list').on(t.userId, t.orgId, t.groupId, t.position)],
);

/** Per-user expanded parents in the list (05 §3, FR-TASK-11). */
export const taskExpansion = sqliteTable(
  'task_expansion',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    taskId: text('task_id')
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.taskId] })],
);
