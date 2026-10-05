import type { Task, TaskDetail } from '../schemas/list.ts';
import { type ApplyContext, applyOp } from './apply.ts';
import { mergeResponse } from './merge.ts';
import type { ListOpSpec } from './ops.ts';
import { childrenOf, emptyListState, type ListState } from './state.ts';

/**
 * The `['task', id]` cache (GET /tasks/:id) as a small list state: the task and its direct
 * subtasks. Ops then apply to a task detail with the very reducers the list uses, so the pane
 * shows optimistic edits even for tasks that are not in My tasks.
 */
export function detailState(detail: TaskDetail): ListState {
  const { subtasks, parentChain: _chain, ...task } = detail;
  const state = emptyListState(detail.orgId);
  const tasks: Record<string, Task> = { [task.id]: task };
  for (const subtask of subtasks) tasks[subtask.id] = subtask;
  return { ...state, tasks };
}

function toDetail(detail: TaskDetail, state: ListState): TaskDetail {
  const task = state.tasks[detail.id];
  if (!task) return detail;
  return {
    ...task,
    description: task.description ?? detail.description,
    subtasks: childrenOf(state, detail.id),
    parentChain: detail.parentChain,
  };
}

/** Applies one op to a task detail (a no-op when the op concerns other tasks). */
export function applyOpToDetail(detail: TaskDetail, op: ListOpSpec, ctx: ApplyContext): TaskDetail {
  const before = detailState(detail);
  const after = applyOp(before, op, ctx);
  return after === before ? detail : toDetail(detail, after);
}

/** Whether `op` concerns the task of a detail or one of its direct subtasks. */
function touches(state: ListState, op: ListOpSpec): boolean {
  switch (op.kind) {
    case 'task.bulk':
      return op.payload.ids.some((id) => id in state.tasks);
    case 'task.create':
      return op.payload.parentId !== undefined && op.payload.parentId in state.tasks;
    case 'tag.create':
    case 'group.create':
    case 'group.patch':
    case 'group.move':
    case 'group.delete':
    case 'group.restore':
      return false;
    default:
      return op.entityId in state.tasks;
  }
}

/**
 * Applies a confirmed op and merges the server's response into a task detail. Response task
 * DTOs carry no description, so the detail keeps the one it has (or the patched one).
 */
export function mergeDetailResponse(
  detail: TaskDetail,
  op: ListOpSpec,
  response: unknown,
  ctx: ApplyContext,
): TaskDetail {
  if (!touches(detailState(detail), op)) return detail;
  const applied = detailState(applyOpToDetail(detail, op, ctx));
  const merged = mergeResponse(applied, op, response).state;
  const result = toDetail(detail, merged);
  const description =
    op.kind === 'task.patch' && op.entityId === detail.id && op.payload.description !== undefined
      ? op.payload.description
      : (applied.tasks[detail.id]?.description ?? detail.description);
  return { ...result, description };
}
