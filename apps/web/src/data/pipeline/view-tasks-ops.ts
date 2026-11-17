import {
  applyOpToTaskList,
  mergeTaskListResponse,
  type TaskListContext,
  type TaskListMerge,
} from '@rooster/core/everyone';
import type { ListOpSpec } from '@rooster/core/reducers';
import { applyRecurrence } from '@rooster/core/reducers/apply';
import type { Task } from '@rooster/core/schemas';

/**
 * Phase 13 (ADR 0073 B): the rows of a view, `['view-tasks', viewId, 'open' | 'all']`, as the
 * cache holds them: the server's matches (`GET /views/:id/tasks`) with the org's queued ops
 * replayed on top. `orgId` says which org's ops apply (the key has only the view's ID).
 */
export interface ViewTasksData {
  orgId: string;
  /** The matches, subtasks included; `@rooster/core/saved-views` filters and groups them. */
  items: readonly Task[];
  /** The server's "7 open · 12 done" when fetched (the screen adds what changed since). */
  counts: { open: number; done: number };
  /** The rows as the server sent them (before the queued ops): what `counts` describe. */
  baseline?: readonly Task[];
}

export function isViewTasksData(data: unknown): data is ViewTasksData {
  const d = data as Partial<ViewTasksData> | undefined;
  return typeof d?.orgId === 'string' && Array.isArray(d.items);
}

/**
 * One op on a view's rows. Everyone's reducer (`applyOpToTaskList`) does the work, with two
 * differences: in a view every task is a row of its own (B5), so a subtask that shares its
 * parent's assignee is created and kept rather than folded into the parent; and a task created
 * with no row of the list to take its org from gets the view's. Rows that stop matching stay
 * in the list: the selector hides them, and the next fetch drops them.
 */
export function applyOpToViewTasks(
  items: readonly Task[],
  op: ListOpSpec,
  ctx: TaskListContext,
  orgId: string,
): readonly Task[] {
  if (op.kind === 'task.create' && op.payload.parentId !== undefined) {
    return createSubtaskRow(items, op, ctx, orgId);
  }
  const next = applyOpToTaskList(items, op, ctx);
  if (next === items) return items;
  let rows = next;
  const assigned =
    op.kind === 'task.patch' && op.payload.assigneeId !== undefined
      ? { ids: [op.entityId], assigneeId: op.payload.assigneeId }
      : op.kind === 'task.bulk' && op.payload.op === 'assign'
        ? { ids: op.payload.ids, assigneeId: op.payload.args.assigneeId }
        : null;
  if (assigned) {
    // Everyone's rows drop children that now share their parent's assignee; a view keeps them
    // (reassigned too when they were among the tasks assigned).
    const kept = new Set(rows.map((t) => t.id));
    const ids = new Set(assigned.ids);
    const dropped = items
      .filter((t) => !kept.has(t.id))
      .map((t) =>
        ids.has(t.id) ? { ...t, assigneeId: assigned.assigneeId, updatedAt: ctx.now } : t,
      );
    if (dropped.length > 0) rows = [...rows, ...dropped];
  }
  if (op.kind === 'task.create' || op.kind === 'task.duplicate') {
    rows = rows.map((t) => (t.orgId === '' ? { ...t, orgId } : t));
  }
  return rows;
}

function createSubtaskRow(
  items: readonly Task[],
  op: Extract<ListOpSpec, { kind: 'task.create' }>,
  ctx: TaskListContext,
  orgId: string,
): readonly Task[] {
  const p = op.payload;
  if (items.some((t) => t.id === p.id)) return items;
  const parent = items.find((t) => t.id === p.parentId);
  // Without the parent its assignee (the default) is unknown here; the next fetch has the row.
  if (!parent && p.assigneeId === undefined) return items;
  const task: Task = {
    id: p.id,
    orgId: parent?.orgId ?? orgId,
    seq: null,
    parentId: p.parentId ?? null,
    subtaskPosition: null,
    title: p.title,
    ...(p.description === undefined ? {} : { description: p.description }),
    hasDescription: p.description !== undefined && p.description.trim() !== '',
    assigneeId: p.assigneeId !== undefined ? p.assigneeId : (parent?.assigneeId ?? null),
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
  const withParent = parent
    ? items.map((t) =>
        t.id === parent.id ? { ...t, counts: { ...t.counts, subtasks: t.counts.subtasks + 1 } } : t,
      )
    : items;
  return [...withParent, applyRecurrence(task, p)];
}

/** The server's answer to an op, merged into a view's rows (as Everyone's). */
export function mergeViewTasksResponse(
  items: readonly Task[],
  op: ListOpSpec,
  response: unknown,
): TaskListMerge {
  return mergeTaskListResponse(items, op, response);
}
