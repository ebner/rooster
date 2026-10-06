import { SUBTASK_DEPTH_MAX } from '../limits.ts';
import { compareKeys, generateKeyBetween, generateNKeysBetween } from '../ordering.ts';
import type { Group, MyList, OrderingIntent, Task } from '../schemas/list.ts';

/**
 * A task soft-deleted on this client. `withGroupId` marks tasks deleted together with a group;
 * `withTaskId` marks descendants deleted by the cascade of that task (05 §4.3), which are
 * restored with it.
 */
export interface DeletedTask {
  task: Task;
  withGroupId?: string;
  withTaskId?: string;
}

/** 05 §4.3 / ADR 0007: depth = number of ancestors, at most this many. */
export { SUBTASK_DEPTH_MAX } from '../limits.ts';

/**
 * The normalized My tasks cache (04 §5.1 `['my-list', orgId]`). Optimistic reducers produce a
 * new state and keep the identity of every untouched task and group, so memoised rows skip
 * re-rendering. Soft-deleted entities are kept so undo and restore put them back exactly.
 */
export interface ListState {
  orgId: string;
  groups: Readonly<Record<string, Group>>;
  tasks: Readonly<Record<string, Task>>;
  deletedTasks: Readonly<Record<string, DeletedTask>>;
  deletedGroups: Readonly<Record<string, Group>>;
  expandedTaskIds: readonly string[];
  serverTime: number;
}

export function emptyListState(orgId: string): ListState {
  return {
    orgId,
    groups: {},
    tasks: {},
    deletedTasks: {},
    deletedGroups: {},
    expandedTaskIds: [],
    serverTime: 0,
  };
}

/**
 * Builds the normalized state from a `GET /my-list` payload. Locally soft-deleted entities of
 * `previous` survive a refetch (the server no longer lists them) so undo still works.
 */
export function normalizeMyList(orgId: string, list: MyList, previous?: ListState): ListState {
  const groups: Record<string, Group> = {};
  for (const group of list.groups) groups[group.id] = group;
  const tasks: Record<string, Task> = {};
  for (const task of list.tasks) tasks[task.id] = task;
  const deletedTasks: Record<string, DeletedTask> = {};
  const deletedGroups: Record<string, Group> = {};
  if (previous) {
    for (const [id, entry] of Object.entries(previous.deletedTasks)) {
      if (!tasks[id]) deletedTasks[id] = entry;
    }
    for (const [id, group] of Object.entries(previous.deletedGroups)) {
      if (!groups[id]) deletedGroups[id] = group;
    }
  }
  return {
    orgId,
    groups,
    tasks,
    deletedTasks,
    deletedGroups,
    expandedTaskIds: list.expandedTaskIds,
    serverTime: list.serverTime,
  };
}

/** `ORDER BY position, id` (04 §7). */
export function comparePlaced(
  a: { readonly id: string; readonly position: string },
  b: { readonly id: string; readonly position: string },
): number {
  return compareKeys(a.position, b.position) || compareKeys(a.id, b.id);
}

export function inboxOf(state: Pick<ListState, 'groups'>): Group | undefined {
  return Object.values(state.groups).find((g) => g.kind === 'inbox');
}

/** Normal (non-Inbox) groups in the user's order. */
export function normalGroups(state: Pick<ListState, 'groups'>): Group[] {
  return Object.values(state.groups)
    .filter((g) => g.kind === 'normal')
    .sort(comparePlaced);
}

/** Every group in display order: the Inbox first, then the user's order. */
export function orderedGroups(state: Pick<ListState, 'groups'>): Group[] {
  const inbox = inboxOf(state);
  const rest = normalGroups(state);
  return inbox ? [inbox, ...rest] : rest;
}

/** The rows placed in a group (open and completed), in list order. Placement = own row (05 §4.1). */
export function tasksInGroup(state: ListState, groupId: string): Task[] {
  return placedIn(Object.values(state.tasks), groupId);
}

function placedIn(tasks: readonly Task[], groupId: string): Task[] {
  return tasks
    .filter((t) => t.placement?.groupId === groupId)
    .sort((a, b) => comparePlacement(a, b));
}

function comparePlacement(a: Task, b: Task): number {
  return (
    compareKeys(a.placement?.position ?? '', b.placement?.position ?? '') || compareKeys(a.id, b.id)
  );
}

interface Keyed {
  readonly id: string;
  readonly position: string;
}

/**
 * Keys for `count` items placed at `intent` within `siblings` (sorted, without the moving
 * items), resolved like the server (ADR 0005 §2): with an `afterId` the items go directly below
 * it; with only a `beforeId`, directly above it; with neither, or a missing neighbour, at the
 * end. The other neighbour is always the real adjacent sibling, so hidden completed items in
 * between never break the order.
 */
export function keysForIntent(
  siblings: readonly Keyed[],
  intent: OrderingIntent,
  count = 1,
): string[] {
  const keys = (a: string | null, b: string | null) =>
    count === 1 ? [generateKeyBetween(a, b)] : generateNKeysBetween(a, b, count);
  const atEnd = () => keys(siblings.at(-1)?.position ?? null, null);
  const afterId = intent.afterId ?? null;
  const beforeId = intent.beforeId ?? null;
  if (afterId !== null) {
    const index = siblings.findIndex((s) => s.id === afterId);
    if (index < 0) return atEnd();
    return keys(siblings[index]?.position ?? null, siblings[index + 1]?.position ?? null);
  }
  if (beforeId !== null) {
    const index = siblings.findIndex((s) => s.id === beforeId);
    if (index < 0) return atEnd();
    return keys(siblings[index - 1]?.position ?? null, siblings[index]?.position ?? null);
  }
  return atEnd();
}

/** Group siblings as `Keyed` items, for `keysForIntent`. */
export function placedKeyed(tasks: readonly Task[]): Keyed[] {
  return tasks.map((t) => ({ id: t.id, position: t.placement?.position ?? '' }));
}

/** The intent that places an item at index `index` of `order` (which excludes the item). */
export function intentAt(order: readonly { id: string }[], index: number): OrderingIntent {
  return { afterId: order[index - 1]?.id ?? null, beforeId: order[index]?.id ?? null };
}

/** Group a task belongs to in the current or deleted state, if any. */
export function groupIdOf(state: ListState, taskId: string): string | undefined {
  return (
    state.tasks[taskId]?.placement?.groupId ?? state.deletedTasks[taskId]?.task.placement?.groupId
  );
}

interface SubtaskKeyed {
  readonly id: string;
  readonly subtaskPosition: string | null;
}

/** Sibling order: `ORDER BY subtask_position, id`. */
export function compareSubtasks(a: SubtaskKeyed, b: SubtaskKeyed): number {
  return compareKeys(a.subtaskPosition ?? '', b.subtaskPosition ?? '') || compareKeys(a.id, b.id);
}

/** The live direct subtasks of `parentId`, in sibling order. */
export function childrenOf(state: ListState, parentId: string): Task[] {
  return Object.values(state.tasks)
    .filter((t) => t.parentId === parentId)
    .sort(compareSubtasks);
}

/** Children per parent in one pass, each list in sibling order (for row building). */
export function childrenIndex(tasks: Iterable<Task>): Map<string, Task[]> {
  const index = new Map<string, Task[]>();
  for (const task of tasks) {
    if (task.parentId === null) continue;
    const list = index.get(task.parentId);
    if (list) list.push(task);
    else index.set(task.parentId, [task]);
  }
  for (const list of index.values()) list.sort(compareSubtasks);
  return index;
}

/** Every live descendant of `id`, parents before their children. */
export function descendantIds(state: ListState, id: string): string[] {
  const index = childrenIndex(Object.values(state.tasks));
  const out: string[] = [];
  const queue = [id];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of index.get(next) ?? []) {
      out.push(child.id);
      queue.push(child.id);
    }
  }
  return out;
}

/** Ancestors known to the state, from the direct parent up (stops at a missing one). */
export function ancestorsOf(state: ListState, id: string): Task[] {
  const out: Task[] = [];
  const seen = new Set([id]);
  let parentId = state.tasks[id]?.parentId ?? null;
  while (parentId !== null && !seen.has(parentId)) {
    const parent = state.tasks[parentId];
    if (!parent) break;
    out.push(parent);
    seen.add(parentId);
    parentId = parent.parentId;
  }
  return out;
}

/** Nesting level of a task: 0 for a top-level task, 1 for its subtasks, and so on. */
export function depthOf(state: ListState, id: string): number {
  return ancestorsOf(state, id).length;
}

/** How many levels of subtasks hang below `id` (0 without subtasks). */
export function subtreeHeight(state: ListState, id: string): number {
  const index = childrenIndex(Object.values(state.tasks));
  const height = (taskId: string, guard: number): number => {
    if (guard > SUBTASK_DEPTH_MAX + 1) return guard;
    let max = 0;
    for (const child of index.get(taskId) ?? [])
      max = Math.max(max, 1 + height(child.id, guard + 1));
    return max;
  };
  return height(id, 0);
}

/** Siblings as `Keyed` items (by subtask position), for `keysForIntent`. */
export function subtaskKeyed(tasks: readonly Task[]): Keyed[] {
  return tasks.map((t) => ({ id: t.id, position: t.subtaskPosition ?? '' }));
}

export function withTask(state: ListState, task: Task): ListState {
  return { ...state, tasks: { ...state.tasks, [task.id]: task } };
}

export function withGroup(state: ListState, group: Group): ListState {
  return { ...state, groups: { ...state.groups, [group.id]: group } };
}

export function omit<T>(record: Readonly<Record<string, T>>, ids: Iterable<string>) {
  const next = { ...record };
  for (const id of ids) delete next[id];
  return next;
}
