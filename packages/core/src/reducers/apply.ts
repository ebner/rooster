import { generateKeyBetween, generateNKeysBetween } from '../ordering.ts';
import type {
  BulkOp,
  Group,
  GroupDelete,
  OrderingIntent,
  Task,
  TaskMove,
  TaskPatch,
} from '../schemas/list.ts';
import type { GroupCreateBody, ListOpSpec, ReducerContext, TaskCreateBody } from './ops.ts';
import {
  type DeletedTask,
  inboxOf,
  keysForIntent,
  type ListState,
  normalGroups,
  omit,
  placedKeyed,
  tasksInGroup,
  withGroup,
  withTask,
} from './state.ts';

export interface ApplyContext extends ReducerContext {
  /** The op's edit time (ms epoch); reducers never read the clock themselves. */
  now: number;
}

/**
 * The optimistic reducer (04 §6.2): applies one op to the state as the server will. Pure and
 * idempotent where the server is (re-applying a create, delete or completion is a no-op), so
 * pending ops can be replayed over a fresh server snapshot.
 */
export function applyOp(state: ListState, op: ListOpSpec, ctx: ApplyContext): ListState {
  switch (op.kind) {
    case 'task.create':
      return createTask(state, op.payload, ctx);
    case 'task.patch':
      return patchTasks(state, [op.entityId], op.payload, ctx.now);
    case 'task.complete':
      return completeTasks(state, [op.entityId], op.payload.completed, ctx.now);
    case 'task.delete':
      return deleteTasks(state, [op.entityId]);
    case 'task.restore':
      return restoreTasks(state, [op.entityId]);
    case 'task.move':
      return moveTasks(state, [op.entityId], op.payload);
    case 'task.bulk':
      return applyBulk(state, op.payload, ctx.now);
    case 'group.create':
      return createGroup(state, op.payload);
    case 'group.patch': {
      const group = state.groups[op.entityId];
      if (!group) return state;
      // ADR 0005 §6: the Inbox can be collapsed but never renamed.
      const rename = op.payload.name !== undefined && group.kind === 'normal';
      if (!rename && op.payload.collapsed === undefined) return state;
      return withGroup(state, {
        ...group,
        ...(rename ? { name: op.payload.name as string } : {}),
        ...(op.payload.collapsed === undefined ? {} : { collapsed: op.payload.collapsed }),
      });
    }
    case 'group.move':
      return moveGroup(state, op.entityId, op.payload);
    case 'group.delete':
      return deleteGroup(state, op.entityId, op.payload);
    case 'group.restore':
      return restoreGroup(state, op.entityId);
  }
}

/** Applies ops in order. */
export function applyOps(
  state: ListState,
  ops: readonly ListOpSpec[],
  ctx: ApplyContext,
): ListState {
  return ops.reduce((s, op) => applyOp(s, op, ctx), state);
}

function createTask(state: ListState, p: TaskCreateBody, ctx: ApplyContext): ListState {
  if (state.tasks[p.id] || state.deletedTasks[p.id]) return state;
  const groupId = state.groups[p.groupId] ? p.groupId : inboxOf(state)?.id;
  if (!groupId) return state;
  const siblings = placedKeyed(tasksInGroup(state, groupId));
  // ADR 0005 §1: no intent fields at all means the top of the Inbox (end of a named group).
  const toInboxTop = groupId !== p.groupId && p.afterId === undefined && p.beforeId === undefined;
  const [position = generateKeyBetween(null, null)] = toInboxTop
    ? [generateKeyBetween(null, siblings[0]?.position ?? null)]
    : keysForIntent(siblings, p);
  const task: Task = {
    id: p.id,
    orgId: state.orgId,
    seq: null,
    parentId: null,
    subtaskPosition: null,
    title: p.title,
    ...(p.description === undefined ? {} : { description: p.description }),
    assigneeId: ctx.userId,
    createdBy: ctx.userId,
    ...dueUnit(p),
    completedAt: null,
    counts: { subtasks: 0, subtasksDone: 0, comments: 0, attachments: 0 },
    placement: { groupId, position },
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  return withTask(state, task);
}

type DueFields = Pick<TaskPatch, 'dueDate' | 'dueTime' | 'dueTz'>;

/** The due unit is replaced as a whole; absent members become null (taskPatchSchema). */
function dueUnit(p: DueFields): Pick<Task, 'dueDate' | 'dueTime' | 'dueTz'> {
  return { dueDate: p.dueDate ?? null, dueTime: p.dueTime ?? null, dueTz: p.dueTz ?? null };
}

export function touchesDue(p: DueFields): boolean {
  return p.dueDate !== undefined || p.dueTime !== undefined || p.dueTz !== undefined;
}

function mapTasks(
  state: ListState,
  ids: readonly string[],
  update: (task: Task) => Task,
): ListState {
  let tasks: Record<string, Task> | null = null;
  for (const id of ids) {
    const task = (tasks ?? state.tasks)[id];
    if (!task) continue;
    const next = update(task);
    if (next === task) continue;
    tasks ??= { ...state.tasks };
    tasks[id] = next;
  }
  return tasks ? { ...state, tasks } : state;
}

function patchTasks(
  state: ListState,
  ids: readonly string[],
  p: TaskPatch,
  now: number,
): ListState {
  return mapTasks(state, ids, (task) => ({
    ...task,
    ...(p.title === undefined ? {} : { title: p.title }),
    ...(p.description === undefined ? {} : { description: p.description }),
    ...(touchesDue(p) ? dueUnit(p) : {}),
    updatedAt: now,
  }));
}

function completeTasks(
  state: ListState,
  ids: readonly string[],
  completed: boolean,
  now: number,
): ListState {
  return mapTasks(state, ids, (task) => {
    if ((task.completedAt !== null) === completed) return task;
    return { ...task, completedAt: completed ? now : null, updatedAt: now };
  });
}

function deleteTasks(state: ListState, ids: readonly string[], withGroupId?: string): ListState {
  const present = ids.filter((id) => state.tasks[id]);
  if (present.length === 0) return state;
  const deletedTasks = { ...state.deletedTasks };
  for (const id of present) {
    const task = state.tasks[id] as Task;
    deletedTasks[id] = withGroupId === undefined ? { task } : { task, withGroupId };
  }
  return { ...state, tasks: omit(state.tasks, present), deletedTasks };
}

function restoreTasks(state: ListState, ids: readonly string[]): ListState {
  const present = ids.filter((id) => state.deletedTasks[id]);
  if (present.length === 0) return state;
  let next: ListState = { ...state, deletedTasks: omit(state.deletedTasks, present) };
  for (const id of present) {
    next = withTask(next, rehome(next, (state.deletedTasks[id] as DeletedTask).task));
  }
  return next;
}

/** 05 §4.1: a restored task whose group is gone goes to the top of the Inbox. */
function rehome(state: ListState, task: Task): Task {
  const groupId = task.placement?.groupId;
  if (!groupId || state.groups[groupId]) return task;
  const inbox = inboxOf(state);
  if (!inbox) return task;
  const first = tasksInGroup(state, inbox.id)[0]?.placement?.position ?? null;
  return { ...task, placement: { groupId: inbox.id, position: generateKeyBetween(null, first) } };
}

function moveTasks(state: ListState, ids: readonly string[], args: TaskMove): ListState {
  const moving = ids.filter((id) => state.tasks[id]?.placement);
  if (moving.length === 0 || !state.groups[args.groupId]) return state;
  const exclude = new Set(moving);
  const siblings = placedKeyed(tasksInGroup(state, args.groupId).filter((t) => !exclude.has(t.id)));
  const keys = keysForIntent(siblings, args, moving.length);
  const tasks = { ...state.tasks };
  moving.forEach((id, i) => {
    const task = tasks[id] as Task;
    tasks[id] = {
      ...task,
      placement: {
        groupId: args.groupId,
        position: keys[i] ?? (task.placement?.position as string),
      },
    };
  });
  return { ...state, tasks };
}

function applyBulk(state: ListState, op: BulkOp, now: number): ListState {
  switch (op.op) {
    case 'complete':
      return completeTasks(state, op.ids, true, now);
    case 'uncomplete':
      return completeTasks(state, op.ids, false, now);
    case 'delete':
      return deleteTasks(state, op.ids);
    case 'restore':
      return restoreTasks(state, op.ids);
    case 'move':
      return moveTasks(state, op.ids, op.args);
    case 'setDue':
      return patchTasks(state, op.ids, dueUnit(op.args), now);
  }
}

function createGroup(state: ListState, p: GroupCreateBody): ListState {
  if (state.groups[p.id] || state.deletedGroups[p.id]) return state;
  const normals = normalGroups(state);
  const split = p.splitAfterTaskId ? state.tasks[p.splitAfterTaskId] : undefined;
  const splitGroupId = split?.placement?.groupId;
  let position: string;
  let movedIds: string[] = [];
  if (split && splitGroupId) {
    // Directly after the split task's group; the Inbox is always first, so after it = top.
    const index = normals.findIndex((g) => g.id === splitGroupId);
    const after = index < 0 ? null : (normals[index]?.position ?? null);
    const before = normals[index + 1]?.position ?? null;
    position = generateKeyBetween(after, before);
    const inGroup = tasksInGroup(state, splitGroupId);
    movedIds = inGroup.slice(inGroup.findIndex((t) => t.id === split.id) + 1).map((t) => t.id);
  } else {
    [position = generateKeyBetween(null, null)] = keysForIntent(normals, p);
  }
  const group: Group = {
    id: p.id,
    orgId: state.orgId,
    kind: 'normal',
    name: p.name,
    position,
    collapsed: false,
  };
  // Moved tasks keep their keys: they are already in order and the new group is empty.
  return mapTasks(withGroup(state, group), movedIds, (task) => ({
    ...task,
    placement: { groupId: p.id, position: task.placement?.position as string },
  }));
}

function moveGroup(state: ListState, id: string, intent: OrderingIntent): ListState {
  const group = state.groups[id];
  if (!group || group.kind === 'inbox') return state;
  const siblings = normalGroups(state).filter((g) => g.id !== id);
  const [position = group.position] = keysForIntent(siblings, intent);
  return withGroup(state, { ...group, position });
}

function deleteGroup(state: ListState, id: string, p: GroupDelete): ListState {
  const group = state.groups[id];
  if (!group || group.kind === 'inbox') return state;
  let next = state;
  const live = tasksInGroup(state, id);
  if (p.deleteTasks) {
    next = deleteTasks(
      next,
      live.map((t) => t.id),
      id,
    );
  } else {
    // ADR 0005 §4: with a target, the tasks are appended to it in their order; without one
    // (only completed leftovers remain) they go to the end of the Inbox. Soft-deleted
    // placements stay with the deleted group.
    const target = p.moveTasksTo ?? inboxOf(state)?.id;
    if (target && state.groups[target]) next = appendTo(next, live, target);
  }
  return {
    ...next,
    groups: omit(next.groups, [id]),
    deletedGroups: { ...next.deletedGroups, [id]: group },
  };
}

function appendTo(state: ListState, tasks: readonly Task[], target: string): ListState {
  if (tasks.length === 0) return state;
  const last = tasksInGroup(state, target).at(-1)?.placement?.position ?? null;
  const keys = generateNKeysBetween(last, null, tasks.length);
  const keyOf = new Map(tasks.map((t, i) => [t.id, keys[i] as string]));
  return mapTasks(
    state,
    tasks.map((t) => t.id),
    (task) => ({ ...task, placement: { groupId: target, position: keyOf.get(task.id) as string } }),
  );
}

function restoreGroup(state: ListState, id: string): ListState {
  const group = state.deletedGroups[id];
  if (!group) return state;
  const next: ListState = {
    ...state,
    groups: { ...state.groups, [id]: group },
    deletedGroups: omit(state.deletedGroups, [id]),
  };
  const alongside = Object.entries(state.deletedTasks)
    .filter(([, e]) => e.withGroupId === id)
    .map(([taskId]) => taskId);
  return restoreTasks(next, alongside);
}
