import { type DueContext, dueState } from './dates/index.ts';
import { compareKeys } from './ordering.ts';
import {
  type ApplyContext,
  applyRecurrence,
  dueUnit,
  recurrencePart,
  touchesDue,
} from './reducers/apply.ts';
import type { ListOpSpec, TaskCreateBody } from './reducers/ops.ts';
import type {
  BulkOp,
  Task,
  TaskCompleteResult,
  TaskPatch,
  TaskPatchResult,
} from './schemas/list.ts';
import { inSmartView } from './views.ts';

/**
 * Everyone's tasks (01 FR-VIEW-2, 02 §11): every task of a shared org, in one section per
 * assignee. Pure, so the web renders the `['everyone', orgId, filters]` cache with it (offline
 * too) and the pipeline keeps that cache optimistic with `applyOpToTaskList`.
 *
 * Rows follow the server's rule: a task is a row iff it has no parent, or its parent's assignee
 * differs from its own (an orphan, which shows with a breadcrumb). A task whose parent is not in
 * the list is a row as well: the server only sends rows, so the client cannot tell otherwise.
 */

export interface EveryoneMember {
  userId: string;
  name: string;
}

/** 02 §11 due filter. `week` is the Next 7 days window (today … today + 6), as the smart view. */
export const EVERYONE_DUE_FILTERS = ['any', 'overdue', 'week', 'nodate'] as const;
export type EveryoneDueFilter = (typeof EVERYONE_DUE_FILTERS)[number];

export interface EveryoneFilters {
  /** Tasks carrying any of these tags (OR, like the list's tag filter that drives it). */
  tagIds?: readonly string[] | undefined;
  /** Default `any`. */
  due?: EveryoneDueFilter | undefined;
  /** The member multi-select: user IDs, `null` for Unassigned. Empty or absent: everyone. */
  assigneeIds?: readonly (string | null)[] | undefined;
  /** Include completed tasks. Default false (open tasks only). */
  showCompleted?: boolean | undefined;
}

export interface EveryoneContext {
  viewerId: string;
  /** The org's members (names for the alphabetical order). */
  members: readonly EveryoneMember[];
  /** The UI locale, for the name collation. */
  locale: string;
  filters?: EveryoneFilters | undefined;
  /** Needed by the `overdue` and `week` due filters only. */
  due?: DueContext | undefined;
}

export interface EveryoneSection {
  /** Null: Unassigned. */
  assigneeId: string | null;
  /** Rows in display order. */
  taskIds: readonly string[];
  /** Open rows in the section (the header count). */
  openCount: number;
}

/**
 * Sections in display order: me, the other members alphabetically, assignees who are not
 * (or no longer) members by ID, then Unassigned. Every member in the member filter (or every
 * member without one) and Unassigned get a section even when empty, since each header has an
 * inline add; an empty section of a non-member is dropped.
 */
export function selectEveryone(tasks: readonly Task[], ctx: EveryoneContext): EveryoneSection[] {
  const filters = ctx.filters ?? {};
  const wanted = filters.assigneeIds?.length ? new Set(filters.assigneeIds) : null;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const rows = new Map<string | null, Task[]>();
  for (const task of tasks) {
    if (!isRow(task, byId) || !matchesEveryoneFilters(task, filters, ctx.due)) continue;
    if (wanted && !wanted.has(task.assigneeId)) continue;
    const list = rows.get(task.assigneeId);
    if (list) list.push(task);
    else rows.set(task.assigneeId, [task]);
  }

  const collator = new Intl.Collator(ctx.locale, { sensitivity: 'base' });
  const others = ctx.members
    .filter((m) => m.userId !== ctx.viewerId)
    .sort((a, b) => collator.compare(a.name, b.name) || compareKeys(a.userId, b.userId))
    .map((m) => m.userId);
  const known = new Set([ctx.viewerId, ...others]);
  const strangers = [...rows.keys()]
    .filter((id): id is string => id !== null && !known.has(id))
    .sort(compareKeys);
  const order: (string | null)[] = [ctx.viewerId, ...others, ...strangers, null];

  const sections: EveryoneSection[] = [];
  for (const assigneeId of order) {
    const list = (rows.get(assigneeId) ?? []).sort(compareRows);
    const isMember = assigneeId === null || known.has(assigneeId);
    if (wanted ? !wanted.has(assigneeId) : !isMember && list.length === 0) continue;
    sections.push({
      assigneeId,
      taskIds: list.map((t) => t.id),
      openCount: list.filter((t) => t.completedAt === null).length,
    });
  }
  return sections;
}

/** The server's row rule (see the module comment). */
export function isRow(task: Task, byId: ReadonlyMap<string, Task>): boolean {
  if (task.parentId === null) return true;
  const parent = byId.get(task.parentId);
  return parent === undefined || parent.assigneeId !== task.assigneeId;
}

/** The tag, due and completion filters (the member filter is the sections' business). */
export function matchesEveryoneFilters(
  task: Task,
  filters: EveryoneFilters,
  due?: DueContext,
): boolean {
  if (task.completedAt !== null && !filters.showCompleted) return false;
  const tags = filters.tagIds ?? [];
  if (tags.length > 0 && !task.tagIds.some((id) => tags.includes(id))) return false;
  switch (filters.due ?? 'any') {
    case 'any':
      return true;
    case 'nodate':
      return task.dueDate === null;
    case 'overdue':
      // Classified as if open, like the smart views: a completed overdue task stays listed.
      return (
        due !== undefined &&
        task.dueDate !== null &&
        dueState({ ...task, completed: false }, due) === 'overdue'
      );
    case 'week':
      return due !== undefined && task.dueDate !== null && inSmartView(task, 'week', due);
  }
}

/** By due date (no date last; timed before untimed on a day), then created, then ID. */
export function compareRows(a: Task, b: Task): number {
  if ((a.dueDate === null) !== (b.dueDate === null)) return a.dueDate === null ? 1 : -1;
  return (
    compareKeys(a.dueDate ?? '', b.dueDate ?? '') ||
    compareTimes(a.dueTime, b.dueTime) ||
    a.createdAt - b.createdAt ||
    compareKeys(a.id, b.id)
  );
}

function compareTimes(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return compareKeys(a, b);
}

// ---------------------------------------------------------------------------------------------
// The optimistic reducer for the `['everyone', orgId, filters]` caches
// ---------------------------------------------------------------------------------------------

export interface TaskListContext extends ApplyContext {
  /**
   * The rows this cache lost when task `id` was deleted (it and the rows below it; the
   * pipeline remembers them with `rowsDeletedWith`), so an undo shows them again before the
   * server answers.
   */
  recall?: ((id: string) => readonly Task[] | undefined) | undefined;
}

/**
 * Applies one op to a flat task list as the server will (the Everyone's tasks rows). Returns
 * the same array when nothing changed. Order is not kept: `selectEveryone` sorts. Rows the
 * list does not have (a subtask that becomes an orphan row) only the server can supply; the
 * pipeline refetches when `mergeTaskListResponse` says so.
 */
export function applyOpToTaskList(
  tasks: readonly Task[],
  op: ListOpSpec,
  ctx: TaskListContext,
): readonly Task[] {
  switch (op.kind) {
    case 'task.create':
      return createRow(tasks, op.payload, ctx);
    case 'task.patch':
      return patchRows(tasks, [op.entityId], op.payload, ctx.now);
    case 'task.complete':
      return completeRows(tasks, [op.entityId], op.payload.completed, ctx.now);
    case 'task.delete':
    case 'task.skip':
      // P10: a skipped occurrence goes to Trash; its next instance comes with the response.
      return deleteRows(tasks, [op.entityId]);
    case 'task.restore':
      return restoreRows(tasks, [op.entityId], ctx);
    case 'task.bulk':
      return bulkRows(tasks, op.payload, ctx);
    case 'task.duplicate': {
      const original = tasks.find((t) => t.id === op.entityId);
      if (!original || tasks.some((t) => t.id === op.payload.id)) return tasks;
      return [
        ...tasks,
        {
          ...original,
          id: op.payload.id,
          seq: null,
          completedAt: null,
          tagIds: [...original.tagIds],
          counts: op.payload.includeSubtasks
            ? { ...original.counts, comments: 0, attachments: 0 }
            : { subtasks: 0, subtasksDone: 0, comments: 0, attachments: 0 },
          createdBy: ctx.userId,
          createdAt: ctx.now,
          updatedAt: ctx.now,
        },
      ];
    }
    case 'task.addTag':
    case 'task.removeTag':
      return tagRows(tasks, [op.entityId], op.payload.tagId, op.kind === 'task.addTag');
    case 'comment.create':
      return countComments(tasks, op.entityId, 1);
    case 'comment.delete':
      return countComments(tasks, op.taskId, -1);
    case 'comment.restore':
      return countComments(tasks, op.taskId, 1);
    case 'task.move':
    case 'task.reorder':
    case 'task.expanded':
    case 'task.follow':
    case 'comment.patch':
    case 'reminder.create':
    case 'reminder.delete':
    case 'tag.create':
    case 'group.create':
    case 'group.patch':
    case 'group.move':
    case 'group.delete':
    case 'group.restore':
      // Placements, sibling order and groups are the viewer's My tasks, not this view's.
      return tasks;
  }
}

export interface TaskListMerge {
  tasks: readonly Task[];
  /** The server changed rows this list cannot derive (assignment, re-parenting, failures). */
  refetch: boolean;
}

const isTask = (v: unknown): v is Task =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as Task).id === 'string' &&
  typeof (v as Task).title === 'string' &&
  'assigneeId' in v;

/**
 * Merges a server response into a task list the op was applied to: response task DTOs
 * replace the optimistic copies (a restored or recurring task joins when it is a row).
 */
export function mergeTaskListResponse(
  tasks: readonly Task[],
  op: ListOpSpec,
  response: unknown,
): TaskListMerge {
  const keep = { tasks, refetch: false };
  switch (op.kind) {
    case 'task.create':
    case 'task.duplicate':
    case 'task.addTag':
    case 'task.removeTag':
      return isTask(response) ? { tasks: putRow(tasks, response, false), refetch: false } : keep;
    case 'task.restore':
      return isTask(response) ? { tasks: putRow(tasks, response, true), refetch: false } : keep;
    case 'task.patch': {
      const r = response as Partial<TaskPatchResult> | undefined;
      const rows = op.payload.assigneeId !== undefined || op.payload.parentId !== undefined;
      const refetch = rows || (r?.ignoredFields?.length ?? 0) > 0;
      return { tasks: isTask(r?.task) ? putRow(tasks, r.task, false) : tasks, refetch };
    }
    case 'task.complete': {
      const r = response as Partial<TaskCompleteResult> | undefined;
      let next = isTask(r?.task) ? putRow(tasks, r.task, false) : tasks;
      if (isTask(r?.next)) next = putRow(next, r.next, true);
      return { tasks: next, refetch: false };
    }
    case 'task.skip': {
      const next = (response as { next?: unknown } | undefined)?.next;
      return isTask(next) ? { tasks: putRow(tasks, next, true), refetch: false } : keep;
    }
    case 'task.bulk': {
      const results = (response as { results?: { ok: boolean }[] } | undefined)?.results ?? [];
      const rows = op.payload.op === 'assign' || op.payload.op === 'restore';
      return { tasks, refetch: rows || results.some((r) => !r.ok) };
    }
    default:
      return keep;
  }
}

/** Replaces a task by ID; `allowNew` adds it when it is a row of the list. */
function putRow(tasks: readonly Task[], task: Task, allowNew: boolean): readonly Task[] {
  const index = tasks.findIndex((t) => t.id === task.id);
  if (index >= 0) return [...tasks.slice(0, index), task, ...tasks.slice(index + 1)];
  if (!allowNew) return tasks;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return isRow(task, byId) ? [...tasks, task] : tasks;
}

function mapRows(
  tasks: readonly Task[],
  ids: readonly string[],
  update: (task: Task) => Task,
): readonly Task[] {
  const wanted = new Set(ids);
  let changed = false;
  const next = tasks.map((task) => {
    if (!wanted.has(task.id)) return task;
    const updated = update(task);
    if (updated !== task) changed = true;
    return updated;
  });
  return changed ? next : tasks;
}

function createRow(
  tasks: readonly Task[],
  p: TaskCreateBody,
  ctx: TaskListContext,
): readonly Task[] {
  if (tasks.some((t) => t.id === p.id)) return tasks;
  const parent = p.parentId === undefined ? undefined : tasks.find((t) => t.id === p.parentId);
  // A subtask whose parent this list lacks: its assignee (and so its row) is unknown.
  if (p.parentId !== undefined && !parent) return tasks;
  const assigneeId =
    p.assigneeId !== undefined ? p.assigneeId : parent ? parent.assigneeId : ctx.userId;
  const task: Task = {
    id: p.id,
    orgId: parent?.orgId ?? tasks[0]?.orgId ?? '',
    seq: null,
    parentId: p.parentId ?? null,
    subtaskPosition: null,
    title: p.title,
    ...(p.description === undefined ? {} : { description: p.description }),
    hasDescription: p.description !== undefined && p.description.trim() !== '',
    assigneeId,
    createdBy: ctx.userId,
    dueDate: p.dueDate ?? null,
    dueTime: p.dueTime ?? null,
    dueTz: p.dueTz ?? null,
    startDate: p.startDate ?? null,
    completedAt: null,
    tagIds: [...new Set(p.tagIds ?? [])],
    counts: { subtasks: 0, subtasksDone: 0, comments: 0, attachments: 0 },
    placement: null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  const row = applyRecurrence(task, p);
  const withParent = parent
    ? mapRows(tasks, [parent.id], (t) => ({
        ...t,
        counts: { ...t.counts, subtasks: t.counts.subtasks + 1 },
      }))
    : tasks;
  return parent && parent.assigneeId === assigneeId ? withParent : [...withParent, row];
}

function patchRows(
  tasks: readonly Task[],
  ids: readonly string[],
  p: TaskPatch,
  now: number,
): readonly Task[] {
  const due = touchesDue(p);
  if (
    p.title === undefined &&
    p.description === undefined &&
    p.assigneeId === undefined &&
    !due &&
    p.recurrence === undefined &&
    p.recurrenceBasis === undefined
  ) {
    return tasks;
  }
  const patched = mapRows(tasks, ids, (task) =>
    applyRecurrence(
      {
        ...task,
        ...(p.title === undefined ? {} : { title: p.title }),
        ...(p.description === undefined
          ? {}
          : { description: p.description, hasDescription: p.description.trim() !== '' }),
        ...(p.assigneeId === undefined ? {} : { assigneeId: p.assigneeId }),
        ...(due ? dueUnit(p) : {}),
        updatedAt: now,
      },
      p,
    ),
  );
  if (p.assigneeId === undefined) return patched;
  // Children that now share their parent's assignee stop being rows (05 §4.1); the ones that
  // become rows the server sends on the refetch.
  const byId = new Map(patched.map((t) => [t.id, t]));
  const wanted = new Set(ids);
  const next = patched.filter(
    (t) => t.parentId === null || !wanted.has(t.parentId) || isRow(t, byId),
  );
  return next.length === patched.length ? patched : next;
}

function completeRows(
  tasks: readonly Task[],
  ids: readonly string[],
  completed: boolean,
  now: number,
): readonly Task[] {
  const changed: Task[] = [];
  let next = mapRows(tasks, ids, (task) => {
    if ((task.completedAt !== null) === completed) return task;
    changed.push(task);
    return { ...task, completedAt: completed ? now : null, updatedAt: now };
  });
  for (const task of changed) {
    if (task.parentId === null) continue;
    next = mapRows(next, [task.parentId], (parent) => ({
      ...parent,
      counts: {
        ...parent.counts,
        subtasksDone: Math.max(0, parent.counts.subtasksDone + (completed ? 1 : -1)),
      },
    }));
  }
  return next;
}

/** Soft delete (05 §4.3): rows below a deleted task in this list go with it. */
function deleteRows(tasks: readonly Task[], ids: readonly string[]): readonly Task[] {
  const gone = new Set(ids.filter((id) => tasks.some((t) => t.id === id)));
  if (gone.size === 0) return tasks;
  let grew = true;
  while (grew) {
    grew = false;
    for (const task of tasks) {
      if (task.parentId !== null && gone.has(task.parentId) && !gone.has(task.id)) {
        gone.add(task.id);
        grew = true;
      }
    }
  }
  return tasks.filter((t) => !gone.has(t.id));
}

/** Restores recalled rows, with the recalled rows below them. */
function restoreRows(
  tasks: readonly Task[],
  ids: readonly string[],
  ctx: TaskListContext,
): readonly Task[] {
  const present = new Set(tasks.map((t) => t.id));
  const back: Task[] = [];
  for (const id of ids) {
    if (present.has(id)) continue;
    for (const task of ctx.recall?.(id) ?? []) {
      if (present.has(task.id)) continue;
      back.push(task);
      present.add(task.id);
    }
  }
  return back.length === 0 ? tasks : [...tasks, ...back];
}

/**
 * For each of `ids` in the list: the rows a delete of it removes (it first, then the rows
 * below it). The pipeline keeps them for `TaskListContext.recall`.
 */
export function rowsDeletedWith(
  tasks: readonly Task[],
  ids: readonly string[],
): Map<string, Task[]> {
  const out = new Map<string, Task[]>();
  for (const id of new Set(ids)) {
    const removed = deleteRows(tasks, [id]);
    if (removed === tasks) continue;
    const kept = new Set(removed.map((t) => t.id));
    const gone = tasks.filter((t) => !kept.has(t.id));
    out.set(id, [...gone.filter((t) => t.id === id), ...gone.filter((t) => t.id !== id)]);
  }
  return out;
}

function tagRows(
  tasks: readonly Task[],
  ids: readonly string[],
  tagId: string,
  add: boolean,
): readonly Task[] {
  return mapRows(tasks, ids, (task) => {
    if (task.tagIds.includes(tagId) === add) return task;
    return {
      ...task,
      tagIds: add ? [...task.tagIds, tagId] : task.tagIds.filter((t) => t !== tagId),
    };
  });
}

function countComments(tasks: readonly Task[], taskId: string, delta: number): readonly Task[] {
  return mapRows(tasks, [taskId], (task) => ({
    ...task,
    counts: { ...task.counts, comments: Math.max(0, task.counts.comments + delta) },
  }));
}

function bulkRows(tasks: readonly Task[], op: BulkOp, ctx: TaskListContext): readonly Task[] {
  switch (op.op) {
    case 'complete':
    case 'uncomplete':
      return completeRows(tasks, op.ids, op.op === 'complete', ctx.now);
    case 'delete':
      return deleteRows(tasks, op.ids);
    case 'restore':
      return restoreRows(tasks, op.ids, ctx);
    case 'setDue':
      // As the My tasks reducer and the server: the due unit is replaced as a whole.
      return patchRows(tasks, op.ids, { ...dueUnit(op.args), ...recurrencePart(op.args) }, ctx.now);
    case 'assign':
      return patchRows(tasks, op.ids, { assigneeId: op.args.assigneeId }, ctx.now);
    case 'addTag':
    case 'removeTag':
      return tagRows(tasks, op.ids, op.args.tagId, op.op === 'addTag');
    case 'move':
      return tasks;
  }
}
