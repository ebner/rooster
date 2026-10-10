import type {
  BulkResult,
  Group,
  GroupCreateResult,
  Placement,
  Task,
  TaskCompleteResult,
  TaskMoveResult,
  TaskPatchResult,
  TaskSkipResult,
} from '../schemas/list.ts';
import type { Reminder } from '../schemas/reminders.ts';
import { earliest } from './apply.ts';
import type { ListOpSpec } from './ops.ts';
import { type ListState, omit } from './state.ts';

export interface MergeResult {
  state: ListState;
  /** The response shows the optimistic guess was wrong in a way only a refetch can fix. */
  refetch: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isTask = (v: unknown): v is Task =>
  isObject(v) && typeof v.id === 'string' && typeof v.title === 'string' && 'placement' in v;
const isGroup = (v: unknown): v is Group =>
  isObject(v) && typeof v.id === 'string' && typeof v.kind === 'string' && 'collapsed' in v;
const isPlacement = (v: unknown): v is Placement =>
  isObject(v) && typeof v.groupId === 'string' && typeof v.position === 'string';

/**
 * Merges a server response into the state the op was optimistically applied to. The server
 * is authoritative (04 §6.2): its keys replace the optimistic ones, its task DTOs replace the
 * local copies. Entities deleted locally in the meantime are not resurrected.
 */
export function mergeResponse(state: ListState, op: ListOpSpec, response: unknown): MergeResult {
  const keep = { state, refetch: false };
  switch (op.kind) {
    case 'task.create':
    case 'task.restore':
      return isTask(response) ? { state: putTask(state, response), refetch: false } : keep;
    case 'task.patch': {
      const r = response as Partial<TaskPatchResult> | undefined;
      if (!isTask(r?.task)) return keep;
      // A task assigned to me from outside my list (Everyone's tasks) joins it with the
      // server's placement; its subtasks, and the children whose rows the reconcile changed,
      // only a refetch brings.
      const assigned = op.payload.assigneeId !== undefined;
      return {
        state: putTask(state, r.task, assigned && r.task.placement !== null),
        refetch: assigned || (r.ignoredFields?.length ?? 0) > 0,
      };
    }
    case 'task.complete': {
      const r = response as Partial<TaskCompleteResult> | undefined;
      if (!isTask(r?.task)) return keep;
      return nextInstance(putTask(state, r.task), op.payload.nextId, r.next);
    }
    case 'task.skip': {
      const r = response as Partial<TaskSkipResult> | undefined;
      if (!isObject(r) || !('next' in r)) return keep;
      return nextInstance(state, op.payload.nextId, r.next ?? undefined);
    }
    case 'task.move': {
      const placement = (response as Partial<TaskMoveResult> | undefined)?.placement;
      return isPlacement(placement)
        ? { state: placeTasks(state, [[op.entityId, placement]]), refetch: false }
        : keep;
    }
    case 'task.bulk': {
      const results = (response as Partial<BulkResult> | undefined)?.results ?? [];
      // Bulk results carry no keys; a move, an assignment (new rows) or any failure needs the
      // server's view.
      const placing = op.payload.op === 'move' || op.payload.op === 'assign';
      // P10: the server created next instances of recurring tasks that only a refetch brings.
      const recurring =
        op.payload.op === 'complete' &&
        op.payload.ids.some((id) => (state.tasks[id]?.recurrence ?? null) !== null);
      return { state, refetch: placing || recurring || results.some((r) => !r.ok) };
    }
    case 'group.create': {
      const r = response as Partial<GroupCreateResult> | undefined;
      if (!isGroup(r?.group)) return keep;
      const next = putGroup(state, r.group);
      const moved = (r.moved ?? []).map(
        (m) => [m.taskId, { groupId: m.groupId, position: m.position }] as const,
      );
      return { state: placeTasks(next, moved), refetch: false };
    }
    case 'group.patch':
      return isGroup(response) ? { state: putGroup(state, response), refetch: false } : keep;
    case 'group.move': {
      const position = isObject(response) ? response.position : undefined;
      const group = state.groups[op.entityId];
      if (typeof position !== 'string' || !group) return keep;
      return { state: putGroup(state, { ...group, position }), refetch: false };
    }
    case 'task.reorder': {
      const position = isObject(response) ? response.subtaskPosition : undefined;
      const task = state.tasks[op.entityId];
      if (typeof position !== 'string' || !task) return keep;
      return { state: putTask(state, { ...task, subtaskPosition: position }), refetch: false };
    }
    case 'task.duplicate':
      // The copied subtasks get server ids: only a refetch replaces the optimistic copies.
      return {
        state: isTask(response) ? putTask(state, response, true) : state,
        refetch: true,
      };
    case 'task.addTag':
    case 'task.removeTag':
      return isTask(response) ? { state: putTask(state, response), refetch: false } : keep;
    case 'reminder.create': {
      // A reminder the optimistic apply could not resolve (or an identical existing one).
      const task = state.tasks[op.taskId];
      if (!isReminder(response) || !task || response.firedAt !== null) return keep;
      const nextReminderAt = earliest(task.nextReminderAt ?? null, [response.fireAt]);
      if (nextReminderAt === (task.nextReminderAt ?? null)) return keep;
      return { state: putTask(state, { ...task, nextReminderAt }), refetch: false };
    }
    case 'reminder.delete':
      // The bell may have been this reminder; only the server knows the next one.
      return { state, refetch: (state.tasks[op.taskId]?.nextReminderAt ?? null) !== null };
    case 'task.expanded':
    case 'task.follow':
    case 'comment.create':
    case 'comment.patch':
    case 'comment.delete':
    case 'comment.restore':
    case 'tag.create':
    case 'task.delete':
    case 'group.delete':
      return keep;
    case 'group.restore':
      // The server restored the tasks deleted with the group; refetch picks up their state.
      return { state, refetch: !isGroup(response) };
  }
}

const isReminder = (v: unknown): v is Reminder =>
  isObject(v) && typeof v.id === 'string' && typeof v.taskId === 'string' && 'fireAt' in v;

/**
 * The next instance of a completion or skip: the server's DTO replaces the optimistic copy
 * (and joins the list when it is a row); without one, the series ended or another instance is
 * still open (ADR 0049 §1.5), so the optimistic copy goes. Its copied subtasks only a refetch
 * brings.
 */
function nextInstance(state: ListState, nextId: string | undefined, next: unknown): MergeResult {
  if (isTask(next)) {
    const base = nextId !== undefined && nextId !== next.id ? dropTask(state, nextId) : state;
    return { state: putTask(base, next, true), refetch: next.counts.subtasks > 0 };
  }
  return { state: nextId === undefined ? state : dropTask(state, nextId), refetch: false };
}

/** Removes an optimistic task the server did not create, and its parent's count of it. */
function dropTask(state: ListState, id: string): ListState {
  const task = state.tasks[id];
  if (!task) return state;
  const tasks = omit(state.tasks, [id]);
  const parent = task.parentId === null ? undefined : tasks[task.parentId];
  if (parent) {
    const subtasks = Math.max(0, parent.counts.subtasks - 1);
    tasks[parent.id] = { ...parent, counts: { ...parent.counts, subtasks } };
  }
  return { ...state, tasks };
}

function putTask(state: ListState, task: Task, allowNew = false): ListState {
  if (!state.tasks[task.id] && !allowNew) return state;
  return { ...state, tasks: { ...state.tasks, [task.id]: task } };
}

function putGroup(state: ListState, group: Group): ListState {
  if (!state.groups[group.id]) return state;
  return { ...state, groups: { ...state.groups, [group.id]: group } };
}

function placeTasks(
  state: ListState,
  placements: readonly (readonly [string, Placement])[],
): ListState {
  let tasks: Record<string, Task> | null = null;
  for (const [id, placement] of placements) {
    const task = (tasks ?? state.tasks)[id];
    if (!task) continue;
    tasks ??= { ...state.tasks };
    tasks[id] = { ...task, placement };
  }
  return tasks ? { ...state, tasks } : state;
}
