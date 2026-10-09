import type {
  BulkResult,
  Group,
  GroupCreateResult,
  Placement,
  Task,
  TaskCompleteResult,
  TaskMoveResult,
  TaskPatchResult,
} from '../schemas/list.ts';
import type { ListOpSpec } from './ops.ts';
import type { ListState } from './state.ts';

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
      return { state: putTask(state, r.task), refetch: (r.ignoredFields?.length ?? 0) > 0 };
    }
    case 'task.complete': {
      const r = response as Partial<TaskCompleteResult> | undefined;
      let next = isTask(r?.task) ? putTask(state, r.task) : state;
      if (isTask(r?.next)) next = putTask(next, r.next, true);
      return { state: next, refetch: false };
    }
    case 'task.move': {
      const placement = (response as Partial<TaskMoveResult> | undefined)?.placement;
      return isPlacement(placement)
        ? { state: placeTasks(state, [[op.entityId, placement]]), refetch: false }
        : keep;
    }
    case 'task.bulk': {
      const results = (response as Partial<BulkResult> | undefined)?.results ?? [];
      // Bulk results carry no keys; a move or any failure needs the server's view.
      return { state, refetch: op.payload.op === 'move' || results.some((r) => !r.ok) };
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
