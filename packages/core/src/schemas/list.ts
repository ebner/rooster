import { z } from 'zod';
import { idSchema, isoDateSchema, timeSchema, timestampSchema } from './common.ts';
import { nameSchema } from './text.ts';

/**
 * Phase 2 list contract: groups, tasks, placements and the my-list payload (05 §5, 06 §2.3–2.4).
 * DTOs are additive-only within API v1. Later phases add fields (startDate, tags, assignee
 * details, recurrence) without changing the meaning of these.
 *
 * Ordering intents (06 §1): `afterId` is the item directly ABOVE the target position (lower key),
 * `beforeId` the item directly BELOW (higher key). Both null/absent = end of the domain;
 * only `afterId` null with a `beforeId` = top.
 */

import { BULK_MAX, GROUP_NAME_MAX, RECURRENCE_RULE_MAX, TASK_TITLE_MAX } from '../limits.ts';
import { isValidRule } from '../recurrence.ts';
import { attachmentSchema } from './attachments.ts';
import { REMINDERS_MAX, reminderSchema, reminderSpecSchema } from './reminders.ts';

export { BULK_MAX, GROUP_NAME_MAX, SUBTASK_DEPTH_MAX, TASK_TITLE_MAX } from '../limits.ts';

export const taskTitleSchema = nameSchema(TASK_TITLE_MAX);
export const groupNameSchema = nameSchema(GROUP_NAME_MAX);
/** Markdown; stored raw, rendered without raw HTML (04 §4.11). */
export const descriptionSchema = z.string().max(100_000);
/** IANA timezone name, e.g. `Europe/Stockholm`. Validity is checked by the server. */
export const timezoneNameSchema = z.string().min(1).max(64);
/** Fractional-index key (04 §7). Opaque to clients except for ordering. */
export const positionSchema = z.string().min(1).max(256);

/**
 * P10 (05 §6): an RRULE subset without the `RRULE:` prefix, e.g. `FREQ=WEEKLY;BYDAY=MO`. The
 * server stores it normalised (`normalizeRule`), so a read may differ from what was sent.
 */
export const recurrenceRuleSchema = z
  .string()
  .max(RECURRENCE_RULE_MAX)
  .refine(isValidRule, { error: 'Expected an RRULE subset such as FREQ=WEEKLY;BYDAY=MO' });
/** `due`: the next date follows the rule; `completion`: it counts from the completion date. */
export const recurrenceBasisSchema = z.enum(['due', 'completion']);

export const orderingIntentSchema = z.object({
  afterId: idSchema.nullable().optional(),
  beforeId: idSchema.nullable().optional(),
});

// ---------------------------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------------------------

export const groupKindSchema = z.enum(['inbox', 'normal']);

export const groupSchema = z.object({
  id: idSchema,
  orgId: idSchema,
  kind: groupKindSchema,
  name: z.string(),
  /** Ignored for the Inbox, which is always first. */
  position: positionSchema,
  collapsed: z.boolean(),
});

export const groupCreateSchema = orderingIntentSchema.extend({
  id: idSchema.optional(),
  name: groupNameSchema,
  /**
   * Tab+N / colon-to-group (02 §4): the new group is inserted directly after this task's group,
   * and every task BELOW this task in that group moves into the new group (order preserved).
   * When set, `afterId`/`beforeId` are ignored.
   */
  splitAfterTaskId: idSchema.optional(),
});

/** Response of POST /orgs/:orgId/groups. `moved` lists placements changed by a split. */
export const groupCreateResultSchema = z.object({
  group: groupSchema,
  moved: z.array(z.object({ taskId: idSchema, groupId: idSchema, position: positionSchema })),
});

export const groupPatchSchema = z
  .object({ name: groupNameSchema.optional(), collapsed: z.boolean().optional() })
  .refine((v) => v.name !== undefined || v.collapsed !== undefined, {
    error: 'Nothing to update',
  });

export const groupMoveSchema = orderingIntentSchema;
/** Response of POST /groups/:id/move: the group's actual (server-computed) position. */
export const groupMoveResultSchema = z.object({ position: positionSchema });

/** Exactly one of the two for a non-empty group; neither for an empty group. */
export const groupDeleteSchema = z.object({
  moveTasksTo: idSchema.optional(),
  deleteTasks: z.literal(true).optional(),
});

// ---------------------------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------------------------

export const placementSchema = z.object({
  groupId: idSchema,
  position: positionSchema,
});

export const taskCountsSchema = z.object({
  subtasks: z.int().nonnegative(),
  subtasksDone: z.int().nonnegative(),
  comments: z.int().nonnegative(),
  attachments: z.int().nonnegative(),
});

export const taskSchema = z.object({
  id: idSchema,
  orgId: idSchema,
  /** Org-scoped human number (#42). Null only while a client-created task is unsynced. */
  seq: z.int().positive().nullable(),
  parentId: idSchema.nullable(),
  subtaskPosition: positionSchema.nullable(),
  title: z.string(),
  /** Omitted in list payloads; present in `GET /tasks/:id`. */
  description: z.string().optional(),
  /** True when the description is non-blank. Present in every payload, list payloads included. */
  hasDescription: z.boolean(),
  assigneeId: idSchema.nullable(),
  createdBy: idSchema,
  dueDate: isoDateSchema.nullable(),
  dueTime: timeSchema.nullable(),
  dueTz: timezoneNameSchema.nullable(),
  /** P3. Part of the due unit; only set together with a due date, and ≤ dueDate. */
  startDate: isoDateSchema.nullable(),
  /**
   * P10 (FR-REC). Part of the due unit; only set together with a due date. Always present in
   * server responses; optional so that caches persisted by older clients still parse.
   */
  recurrence: recurrenceRuleSchema.nullable().optional(),
  /** P10. Non-null exactly when `recurrence` is. */
  recurrenceBasis: recurrenceBasisSchema.nullable().optional(),
  /**
   * P10 (FR-REM-4): the requesting user's next pending reminder (ms epoch), the row's bell.
   * Null when they have none, or only fired or dormant ones. Optional like `recurrence`.
   */
  nextReminderAt: timestampSchema.nullable().optional(),
  completedAt: timestampSchema.nullable(),
  /** P3. Tag ids (org tags); order = the order they were added. */
  tagIds: z.array(idSchema),
  counts: taskCountsSchema,
  /** The requesting user's placement; null when the task is not in their My tasks. */
  placement: placementSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  /** Present only in Trash payloads. */
  deletedAt: timestampSchema.optional(),
  deletedBy: idSchema.optional(),
});

export const myListSchema = z.object({
  groups: z.array(groupSchema),
  /**
   * Every task placed in my list (open + completed within `completedSince`), PLUS (P3, with
   * `placement: null`): all non-deleted subtasks (any depth, any assignee) of those tasks, and
   * the parent chain of my orphan subtasks (for breadcrumbs). Clients tell them apart by
   * `placement` and `parentId`.
   */
  tasks: z.array(taskSchema),
  expandedTaskIds: z.array(idSchema),
  serverTime: timestampSchema,
});

/** The due unit is one LWW field (05 §4.4): date, time and timezone change together. */
const dueFields = {
  dueDate: isoDateSchema.nullable().optional(),
  dueTime: timeSchema.nullable().optional(),
  dueTz: timezoneNameSchema.nullable().optional(),
  startDate: isoDateSchema.nullable().optional(),
  /**
   * P10. Unlike the other members, absent recurrence fields are KEPT when the due unit is
   * replaced; clearing the due date (`dueDate: null`) clears them too (FR-REC-4). `recurrence`
   * without `recurrenceBasis` means basis `due`; `recurrence: null` stops the series.
   */
  recurrence: recurrenceRuleSchema.nullable().optional(),
  recurrenceBasis: recurrenceBasisSchema.nullable().optional(),
};

function dueConsistent(v: {
  dueDate?: string | null | undefined;
  dueTime?: string | null | undefined;
  dueTz?: string | null | undefined;
  startDate?: string | null | undefined;
  recurrence?: string | null | undefined;
  recurrenceBasis?: string | null | undefined;
}): boolean {
  // A time needs a date and a timezone.
  if (v.dueTime && !(v.dueDate && v.dueTz)) return false;
  // A series needs a due date; one cleared in the same request cannot get a rule.
  if (v.recurrence && v.dueDate === null) return false;
  // A basis without a rule is meaningless, unless the rule is being cleared with it.
  if (v.recurrenceBasis && v.recurrence === null) return false;
  // A start date needs a due date and must not be after it (ISO strings compare correctly).
  if (v.startDate) return Boolean(v.dueDate) && v.startDate <= (v.dueDate as string);
  return true;
}
const DUE_ERROR =
  'dueTime requires dueDate and dueTz; startDate requires dueDate and must be ≤ it; recurrence requires dueDate';

export const taskCreateSchema = orderingIntentSchema
  .extend({
    id: idSchema.optional(),
    title: taskTitleSchema,
    description: descriptionSchema.optional(),
    ...dueFields,
    /** Target group in the actor's list; defaults to the Inbox (FR-GRP-5). Ignored for subtasks. */
    groupId: idSchema.optional(),
    /**
     * P3. Creates a subtask (same org, depth ≤ 5). Ordering intents then refer to SIBLING
     * subtasks; with no intent the subtask goes to the end of its siblings.
     */
    parentId: idSchema.optional(),
    /** P3. Existing org tags to attach. */
    tagIds: z.array(idSchema).max(50).optional(),
    /** P3. Tag names to attach; unknown names are created with the next palette colour. */
    tagNames: z.array(z.string().min(1).max(40)).max(50).optional(),
    /**
     * P6. Default: the actor (a subtask: its parent's assignee). Another member puts the task
     * at the top of THEIR Inbox (05 §4.1; `groupId` and intents are then ignored); null creates
     * it unassigned (no placement). Personal orgs accept only the actor.
     */
    assigneeId: idSchema.nullable().optional(),
    /** P10 (FR-REM): the actor's reminders; relative ones need a due date (`422 reminder_needs_due`). */
    reminders: z.array(reminderSpecSchema).max(REMINDERS_MAX).optional(),
    /**
     * CLI/MCP: run the NL parser on the title server-side (06 §2.4). P10: it also reads a
     * recurrence phrase ("every mon") and reminder tokens (`!1h`).
     */
    parse: z.boolean().optional(),
  })
  .refine(dueConsistent, { error: DUE_ERROR, path: ['dueTime'] });

/**
 * Partial update. Due semantics: if any of dueDate/dueTime/dueTz is present the unit is replaced
 * as a whole — absent members of the unit become null; `dueDate: null` clears the due date.
 */
export const taskPatchSchema = z
  .object({
    title: taskTitleSchema.optional(),
    description: descriptionSchema.optional(),
    ...dueFields,
    /**
     * P3. Re-parent: an id makes it a subtask (appended to the new parent's subtasks; cycles and
     * depth > 5 → 422), null makes it top-level (placed at the top of the assignee's Inbox).
     */
    parentId: idSchema.nullable().optional(),
    /**
     * P6 (FR-COL-1/2). An org member or null (unassigned). LWW key `assignee`. A changed
     * assignee moves the placement to the top of the new assignee's Inbox (05 §4.1).
     */
    assigneeId: idSchema.nullable().optional(),
    /**
     * P10 (FR-REM). Not LWW fields: they act on the actor's own reminders after the patch is
     * applied. `clearReminders` removes them all first; `reminders` then adds these (an
     * existing identical reminder is kept, not duplicated).
     */
    reminders: z.array(reminderSpecSchema).max(REMINDERS_MAX).optional(),
    clearReminders: z.literal(true).optional(),
  })
  .refine(dueConsistent, { error: DUE_ERROR, path: ['dueTime'] })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { error: 'Nothing to update' });

export const taskPatchResultSchema = z.object({
  task: taskSchema,
  /** Fields skipped because a newer edit already won (per-field LWW, 04 §6.2). */
  ignoredFields: z.array(z.string()),
});

export const taskMoveSchema = orderingIntentSchema.extend({ groupId: idSchema });
export const taskMoveResultSchema = z.object({ placement: placementSchema });

export const taskCompleteSchema = z.object({
  completed: z.boolean(),
  /**
   * P10 (FR-REC-3): the id for the next instance when completing a recurring task, so that an
   * optimistic client (and its undo) can refer to it before the response. Ignored otherwise.
   * A series has at most one open instance: completing again after a reopen creates none.
   */
  nextId: idSchema.optional(),
});
export const taskCompleteResultSchema = z.object({
  task: taskSchema,
  /** The next recurring instance (P10). */
  next: taskSchema.optional(),
});

/**
 * P10 (FR-REC-4) POST /tasks/:id/skip: "delete this occurrence". The task goes to Trash like a
 * delete, and the series continues with the next instance (as if it had been completed today).
 * A plain DELETE is "this and following": it ends the series.
 */
export const taskSkipSchema = z.object({ nextId: idSchema.optional() });
export const taskSkipResultSchema = z.object({
  /** Null when the series ended with this occurrence (COUNT/UNTIL) or the task does not repeat. */
  next: taskSchema.nullable(),
});

const bulkIds = z.array(idSchema).min(1).max(BULK_MAX);

export const bulkOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('complete'), ids: bulkIds }),
  z.object({ op: z.literal('uncomplete'), ids: bulkIds }),
  z.object({ op: z.literal('delete'), ids: bulkIds }),
  z.object({ op: z.literal('restore'), ids: bulkIds }),
  z.object({
    op: z.literal('move'),
    /** Moved tasks keep the order given here and are placed consecutively at the target. */
    ids: bulkIds,
    args: taskMoveSchema,
  }),
  z.object({ op: z.literal('addTag'), ids: bulkIds, args: z.object({ tagId: idSchema }) }),
  z.object({ op: z.literal('removeTag'), ids: bulkIds, args: z.object({ tagId: idSchema }) }),
  z.object({
    op: z.literal('setDue'),
    ids: bulkIds,
    args: z.object(dueFields).refine(dueConsistent, { error: DUE_ERROR }),
  }),
  /** P6. Same semantics as `PATCH {assigneeId}` per task. */
  z.object({
    op: z.literal('assign'),
    ids: bulkIds,
    args: z.object({ assigneeId: idSchema.nullable() }),
  }),
]);

export const bulkResultSchema = z.object({
  results: z.array(z.object({ id: idSchema, ok: z.boolean(), code: z.string().optional() })),
});

/** P3. GET /tasks/:id. */
export const taskDetailSchema = taskSchema.extend({
  description: z.string(),
  /** Direct subtasks in sibling order (deeper levels are loaded via their own detail). */
  subtasks: z.array(taskSchema),
  /** Ancestors from the root down to the direct parent. */
  parentChain: z.array(z.object({ id: idSchema, title: z.string() })),
  /** P6. Active (unmuted) followers, in follow order (FR-COL-4). Empty in personal orgs. */
  followers: z.array(idSchema),
  /** P10. Live attachments, oldest first. Optional for caches persisted by older clients. */
  attachments: z.array(attachmentSchema).optional(),
  /** P10. The requesting user's reminders (pending, fired and dormant), by `fireAt`. */
  reminders: z.array(reminderSchema).optional(),
});

/** P3. POST /tasks/:id/reorder — among subtask siblings. */
export const subtaskReorderSchema = orderingIntentSchema;
export const subtaskReorderResultSchema = z.object({ subtaskPosition: positionSchema });

/** P3. POST /tasks/:id/duplicate — the copy is placed directly after the original. */
export const taskDuplicateSchema = z.object({
  id: idSchema.optional(),
  includeSubtasks: z.boolean().default(true),
});

export const trashPageSchema = z.object({
  items: z.array(taskSchema),
  nextCursor: z.string().nullable(),
});

export type GroupKind = z.infer<typeof groupKindSchema>;
export type Group = z.infer<typeof groupSchema>;
export type GroupCreate = z.infer<typeof groupCreateSchema>;
export type GroupCreateResult = z.infer<typeof groupCreateResultSchema>;
export type GroupPatch = z.infer<typeof groupPatchSchema>;
export type GroupMove = z.infer<typeof groupMoveSchema>;
export type GroupMoveResult = z.infer<typeof groupMoveResultSchema>;
export type GroupDelete = z.infer<typeof groupDeleteSchema>;
export type Placement = z.infer<typeof placementSchema>;
export type TaskCounts = z.infer<typeof taskCountsSchema>;
export type Task = z.infer<typeof taskSchema>;
export type MyList = z.infer<typeof myListSchema>;
export type TaskCreate = z.infer<typeof taskCreateSchema>;
export type TaskPatch = z.infer<typeof taskPatchSchema>;
export type TaskPatchResult = z.infer<typeof taskPatchResultSchema>;
export type TaskMove = z.infer<typeof taskMoveSchema>;
export type TaskMoveResult = z.infer<typeof taskMoveResultSchema>;
export type TaskComplete = z.infer<typeof taskCompleteSchema>;
export type TaskSkip = z.infer<typeof taskSkipSchema>;
export type TaskSkipResult = z.infer<typeof taskSkipResultSchema>;
export type RecurrenceBasisValue = z.infer<typeof recurrenceBasisSchema>;
export type TaskCompleteResult = z.infer<typeof taskCompleteResultSchema>;
export type BulkOp = z.infer<typeof bulkOpSchema>;
export type BulkResult = z.infer<typeof bulkResultSchema>;
export type TrashPage = z.infer<typeof trashPageSchema>;
export type TaskDetail = z.infer<typeof taskDetailSchema>;
export type SubtaskReorder = z.infer<typeof subtaskReorderSchema>;
export type SubtaskReorderResult = z.infer<typeof subtaskReorderResultSchema>;
export type TaskDuplicate = z.infer<typeof taskDuplicateSchema>;
export type OrderingIntent = z.infer<typeof orderingIntentSchema>;
