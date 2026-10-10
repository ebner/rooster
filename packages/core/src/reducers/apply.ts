import { todayIn } from '../dates/iso.ts';
import { DEFAULT_PREFS } from '../limits.ts';
import { generateKeyBetween, generateNKeysBetween } from '../ordering.ts';
import { nextInstance, normalizeRule } from '../recurrence.ts';
import { resolveFireAt } from '../reminders.ts';
import type {
  BulkOp,
  Group,
  GroupDelete,
  OrderingIntent,
  Task,
  TaskComplete,
  TaskMove,
  TaskPatch,
} from '../schemas/list.ts';
import type { ReminderSpecInput } from '../schemas/reminders.ts';
import type {
  GroupCreateBody,
  ListOpSpec,
  ReducerContext,
  TaskCreateBody,
  TaskDuplicateBody,
} from './ops.ts';
import {
  childrenIndex,
  childrenOf,
  type DeletedTask,
  depthOf,
  descendantIds,
  inboxOf,
  keysForIntent,
  type ListState,
  normalGroups,
  omit,
  placedKeyed,
  SUBTASK_DEPTH_MAX,
  subtaskKeyed,
  subtreeHeight,
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
    case 'task.patch': {
      let patched = patchTasks(state, [op.entityId], op.payload, ctx.now);
      if (op.payload.reminders !== undefined || op.payload.clearReminders) {
        const reminders = op.payload.reminders ?? [];
        patched = remindTask(patched, op.entityId, reminders, op.payload.clearReminders, ctx);
      }
      if (op.payload.assigneeId !== undefined) {
        patched = assignTasks(patched, [op.entityId], op.payload.assigneeId, ctx);
      }
      return op.payload.parentId === undefined
        ? patched
        : reparent(patched, op.entityId, op.payload.parentId, ctx);
    }
    case 'task.complete':
      return completeTask(state, op.entityId, op.payload, ctx);
    case 'task.skip': {
      // FR-REC-4 "this occurrence": the series goes on as if it had been completed today.
      const task = state.tasks[op.entityId];
      if (!task) return state;
      const nextId = op.payload.nextId;
      const spawned = nextId === undefined ? state : spawnNext(state, task, nextId, ctx);
      return deleteTasks(spawned, [op.entityId]);
    }
    case 'task.delete':
      return deleteTasks(state, [op.entityId]);
    case 'task.restore':
      return restoreTasks(state, [op.entityId], ctx.userId);
    case 'task.move':
      return moveTasks(state, [op.entityId], op.payload);
    case 'task.bulk':
      return applyBulk(state, op.payload, ctx);
    case 'task.reorder':
      return reorderSubtask(state, op.entityId, op.payload);
    case 'task.duplicate':
      return duplicateTask(state, op.entityId, op.payload, ctx);
    case 'task.expanded':
      return setExpanded(state, op.entityId, op.payload.expanded);
    case 'task.addTag':
    case 'task.removeTag':
      return tagTasks(state, [op.entityId], op.payload.tagId, op.kind === 'task.addTag');
    case 'tag.create':
      // Tags live in their own cache (['tags', orgId]); the list state holds only tag ids.
      return state;
    case 'task.follow':
    case 'comment.patch':
      // Followers and comments live in the detail and activity caches; the list holds counts.
      return state;
    case 'comment.create':
      return countComment(state, op.entityId, 1);
    case 'comment.delete':
      return countComment(state, op.taskId, -1);
    case 'comment.restore':
      return countComment(state, op.taskId, 1);
    case 'reminder.create':
      return remindTask(state, op.taskId, [op.payload], false, ctx);
    case 'reminder.delete':
      // The list does not know the user's other reminders: the bell is settled by the
      // response (mergeResponse asks for a refetch) or the detail cache.
      return state;
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
      return restoreGroup(state, op.entityId, ctx.userId);
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

const noCounts = () => ({ subtasks: 0, subtasksDone: 0, comments: 0, attachments: 0 });

/** Mirrors the server's `hasDescription`: a description of only whitespace counts as none. */
const hasText = (description: string | undefined) =>
  description !== undefined && description.trim() !== '';

function createTask(state: ListState, p: TaskCreateBody, ctx: ApplyContext): ListState {
  if (state.tasks[p.id] || state.deletedTasks[p.id]) return state;
  if (p.parentId !== undefined) return createSubtask(state, p, p.parentId, ctx);
  const assigneeId = p.assigneeId === undefined ? ctx.userId : p.assigneeId;
  // 05 §4.1: someone else's task (or an unassigned one) has no row in my list.
  if (assigneeId !== ctx.userId) return withTask(state, newTask(state, p, assigneeId, null, ctx));
  const groupId = p.groupId && state.groups[p.groupId] ? p.groupId : inboxOf(state)?.id;
  if (!groupId) return state;
  const siblings = placedKeyed(tasksInGroup(state, groupId));
  // ADR 0005 §1: no intent fields at all means the top of the Inbox (end of a named group).
  const toInboxTop = groupId !== p.groupId && p.afterId === undefined && p.beforeId === undefined;
  const [position = generateKeyBetween(null, null)] = toInboxTop
    ? [generateKeyBetween(null, siblings[0]?.position ?? null)]
    : keysForIntent(siblings, p);
  return withTask(state, newTask(state, p, ctx.userId, { groupId, position }, ctx));
}

/** A fresh top-level task as the server creates it. */
function newTask(
  state: ListState,
  p: TaskCreateBody,
  assigneeId: string | null,
  placement: Task['placement'],
  ctx: ApplyContext,
): Task {
  const task: Task = {
    id: p.id,
    orgId: state.orgId,
    seq: null,
    parentId: null,
    subtaskPosition: null,
    title: p.title,
    ...(p.description === undefined ? {} : { description: p.description }),
    hasDescription: hasText(p.description),
    assigneeId,
    createdBy: ctx.userId,
    ...dueUnit(p),
    completedAt: null,
    tagIds: uniqueIds(p.tagIds ?? []),
    counts: noCounts(),
    placement,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  const withRule = applyRecurrence(task, p);
  if (!p.reminders?.length) return withRule;
  return { ...withRule, nextReminderAt: earliest(null, firesOf(p.reminders, withRule, ctx)) };
}

const uniqueIds = (ids: readonly string[]) => [...new Set(ids)];

/**
 * A subtask (P3): ordered among its siblings by the intent (end without one), assigned like its
 * parent unless the create names an assignee (P6). One of mine under someone else's parent is
 * an orphan and gets its own row at the top of the Inbox (05 §4.1). Over-deep nesting is
 * rejected by the server (422); the optimistic state then never shows it.
 */
function createSubtask(
  state: ListState,
  p: TaskCreateBody,
  parentId: string,
  ctx: ApplyContext,
): ListState {
  const parent = state.tasks[parentId];
  if (!parent || depthOf(state, parentId) + 1 > SUBTASK_DEPTH_MAX) return state;
  const siblings = subtaskKeyed(childrenOf(state, parentId));
  const [subtaskPosition = generateKeyBetween(null, null)] = keysForIntent(siblings, {
    afterId: p.afterId ?? null,
    beforeId: p.beforeId ?? null,
  });
  const task: Task = {
    ...newTask(state, p, p.assigneeId === undefined ? parent.assigneeId : p.assigneeId, null, ctx),
    parentId,
    subtaskPosition,
  };
  const placed = needsPlacement(task, parent, ctx.userId) ? { placement: inboxTop(state) } : {};
  return adjustCounts(withTask(state, { ...task, ...placed }), parentId, 1, 0);
}

/** Keeps a parent's `subtasks`/`subtasksDone` counters in step with its children. */
function adjustCounts(
  state: ListState,
  parentId: string | null,
  subtasks: number,
  done: number,
): ListState {
  const parent = parentId === null ? undefined : state.tasks[parentId];
  if (!parent || (subtasks === 0 && done === 0)) return state;
  return withTask(state, {
    ...parent,
    counts: {
      ...parent.counts,
      subtasks: Math.max(0, parent.counts.subtasks + subtasks),
      subtasksDone: Math.max(0, parent.counts.subtasksDone + done),
    },
  });
}

/** Whether a task needs its own row in the actor's list (05 §4.1), given its parent. */
function needsPlacement(task: Task, parent: Task | undefined, userId: string): boolean {
  if (task.assigneeId !== userId) return false;
  return task.parentId === null || parent?.assigneeId !== task.assigneeId;
}

/** The top of the Inbox (05 §4.1 reconcile: a new placement goes there). */
function inboxTop(state: ListState): Task['placement'] {
  const inbox = inboxOf(state);
  if (!inbox) return null;
  const first = tasksInGroup(state, inbox.id)[0]?.placement?.position ?? null;
  return { groupId: inbox.id, position: generateKeyBetween(null, first) };
}

/**
 * Assignment (P6, FR-COL-1/2) with the 05 §4.1 reconcile seen from my list: a task assigned
 * away from me loses its row; one assigned to me gets a new row at the top of my Inbox. Its
 * direct children are reconciled too, since their row depends on the parent's assignee (an
 * orphan subtask row appears or disappears). Tasks that leave the list stay in the state
 * without a placement; the row model only renders placed tasks and their subtrees.
 */
function assignTasks(
  state: ListState,
  ids: readonly string[],
  assigneeId: string | null,
  ctx: ApplyContext,
): ListState {
  let next = state;
  for (const id of ids) {
    const task = next.tasks[id];
    if (!task || task.assigneeId === assigneeId) continue;
    const parent = task.parentId === null ? undefined : next.tasks[task.parentId];
    const assigned: Task = { ...task, assigneeId, updatedAt: ctx.now };
    // A changed assignee always means a new placement (the old one was someone else's).
    const placement = needsPlacement(assigned, parent, ctx.userId) ? inboxTop(next) : null;
    next = withTask(next, { ...assigned, placement });
    for (const child of childrenOf(next, id)) {
      const needs = needsPlacement(child, next.tasks[id], ctx.userId);
      if (needs === (child.placement !== null)) continue;
      next = withTask(next, { ...child, placement: needs ? inboxTop(next) : null });
    }
  }
  return next;
}

/** `counts.comments` follows comment creates, deletes and restores (the row's indicator). */
function countComment(state: ListState, taskId: string, delta: number): ListState {
  const task = state.tasks[taskId];
  if (!task) return state;
  const comments = Math.max(0, task.counts.comments + delta);
  return withTask(state, { ...task, counts: { ...task.counts, comments } });
}

/**
 * Re-parent (taskPatchSchema `parentId`): appended to the new parent's subtasks, or made
 * top-level. Cycles and over-deep nesting are left to the server's 422. The placement follows
 * the reconcile rules: kept when still needed, removed when not, the Inbox top when new.
 */
function reparent(
  state: ListState,
  id: string,
  parentId: string | null,
  ctx: ApplyContext,
): ListState {
  const task = state.tasks[id];
  if (!task || task.parentId === parentId) return state;
  let subtaskPosition: string | null = null;
  let parent: Task | undefined;
  if (parentId !== null) {
    parent = state.tasks[parentId];
    if (!parent || parentId === id || descendantIds(state, id).includes(parentId)) return state;
    if (depthOf(state, parentId) + 1 + subtreeHeight(state, id) > SUBTASK_DEPTH_MAX) return state;
    subtaskPosition = generateKeyBetween(
      childrenOf(state, parentId).at(-1)?.subtaskPosition ?? null,
      null,
    );
  }
  const moved: Task = { ...task, parentId, subtaskPosition };
  const placed = needsPlacement(moved, parent, ctx.userId);
  const next: Task = {
    ...moved,
    placement: placed ? (task.placement ?? inboxTop(state)) : null,
    updatedAt: ctx.now,
  };
  const done = task.completedAt === null ? 0 : 1;
  let result = withTask(state, next);
  result = adjustCounts(result, task.parentId, -1, -done);
  return adjustCounts(result, parentId, 1, done);
}

/** POST /tasks/:id/reorder: among the task's siblings. */
function reorderSubtask(state: ListState, id: string, intent: OrderingIntent): ListState {
  const task = state.tasks[id];
  if (!task || task.parentId === null) return state;
  const siblings = subtaskKeyed(childrenOf(state, task.parentId).filter((t) => t.id !== id));
  const [subtaskPosition = task.subtaskPosition] = keysForIntent(siblings, intent);
  if (subtaskPosition === task.subtaskPosition) return state;
  return withTask(state, { ...task, subtaskPosition });
}

function setExpanded(state: ListState, id: string, expanded: boolean): ListState {
  const has = state.expandedTaskIds.includes(id);
  if (has === expanded) return state;
  return {
    ...state,
    expandedTaskIds: expanded
      ? [...state.expandedTaskIds, id]
      : state.expandedTaskIds.filter((t) => t !== id),
  };
}

/**
 * Ids for the optimistic copies of subtasks: derived from the copy's id, so replaying the op
 * gives the same rows. They are local only; the server's ids replace them on the refetch that
 * follows the response.
 */
export function derivedTaskId(copyId: string, index: number): string {
  const suffix = (index + 1).toString(16).padStart(12, '0').slice(-12);
  return `${copyId.slice(0, -12)}${suffix}`;
}

/**
 * Duplicate (FR-TASK-13): title, description, dates, tags and (optionally) subtasks are copied;
 * the copy is open and sits directly after the original (in its group, or among its siblings).
 */
function duplicateTask(
  state: ListState,
  id: string,
  p: TaskDuplicateBody,
  ctx: ApplyContext,
): ListState {
  const original = state.tasks[id];
  if (!original || state.tasks[p.id] || state.deletedTasks[p.id]) return state;
  const index = childrenIndex(Object.values(state.tasks));
  const copies: Task[] = [];
  const idMap = new Map<string, string>([[id, p.id]]);
  if (p.includeSubtasks) {
    const queue = [id];
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      for (const child of index.get(next) ?? []) {
        idMap.set(child.id, derivedTaskId(p.id, idMap.size - 1));
        queue.push(child.id);
      }
    }
  }
  const fresh = (task: Task, copyId: string): Task => ({
    ...task,
    id: copyId,
    seq: null,
    tagIds: [...task.tagIds],
    createdBy: ctx.userId,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  });
  let placement = original.placement;
  if (placement) {
    const siblings = placedKeyed(tasksInGroup(state, placement.groupId));
    const [position = placement.position] = keysForIntent(siblings, { afterId: id });
    placement = { groupId: placement.groupId, position };
  }
  let subtaskPosition = original.subtaskPosition;
  if (original.parentId !== null) {
    const siblings = subtaskKeyed(childrenOf(state, original.parentId));
    [subtaskPosition = original.subtaskPosition] = keysForIntent(siblings, { afterId: id });
  }
  copies.push({
    ...fresh(original, p.id),
    completedAt: null,
    placement,
    subtaskPosition,
    counts: p.includeSubtasks ? { ...original.counts, comments: 0, attachments: 0 } : noCounts(),
  });
  for (const [sourceId, copyId] of idMap) {
    if (sourceId === id) continue;
    const source = state.tasks[sourceId] as Task;
    copies.push({
      ...fresh(source, copyId),
      parentId: idMap.get(source.parentId as string) ?? source.parentId,
      placement: null,
      counts: { ...source.counts, comments: 0, attachments: 0 },
    });
  }
  const tasks = { ...state.tasks };
  for (const copy of copies) tasks[copy.id] = copy;
  return adjustCounts({ ...state, tasks }, original.parentId, 1, 0);
}

type DueFields = Pick<TaskPatch, 'dueDate' | 'dueTime' | 'dueTz' | 'startDate'>;
type RecurrenceFields = Pick<TaskPatch, 'recurrence' | 'recurrenceBasis'>;

/** The due unit is replaced as a whole; absent members become null (taskPatchSchema). */
function dueUnit(p: DueFields): Pick<Task, 'dueDate' | 'dueTime' | 'dueTz' | 'startDate'> {
  return {
    dueDate: p.dueDate ?? null,
    dueTime: p.dueTime ?? null,
    dueTz: p.dueTz ?? null,
    startDate: p.startDate ?? null,
  };
}

/** Whether a patch replaces the due unit (the recurrence fields are not part of that). */
export function touchesDue(p: DueFields): boolean {
  return (
    p.dueDate !== undefined ||
    p.dueTime !== undefined ||
    p.dueTz !== undefined ||
    p.startDate !== undefined
  );
}

/** P10: whether a patch names the recurrence fields. */
export function touchesRecurrence(p: RecurrenceFields): boolean {
  return p.recurrence !== undefined || p.recurrenceBasis !== undefined;
}

/** The recurrence fields actually given (for a bulk `setDue` that also sets a rule). */
function recurrencePart(p: RecurrenceFields): RecurrenceFields {
  return {
    ...(p.recurrence === undefined ? {} : { recurrence: p.recurrence }),
    ...(p.recurrenceBasis === undefined ? {} : { recurrenceBasis: p.recurrenceBasis }),
  };
}

/**
 * The recurrence fields after a create or patch whose due unit `task` already has (ADR 0049
 * §1.8): no due date clears the rule and the basis; `recurrence: null` stops the series; a
 * rule without a basis means `due`; a basis alone re-normalises the current rule; absent
 * fields keep what the task has. Rules are stored normalised against the due date. A task
 * that never had the fields (an older cache) only gains them when one is set.
 */
function applyRecurrence(task: Task, p: RecurrenceFields): Task {
  const current = task.recurrence ?? null;
  const set = (recurrence: string | null, basis: 'due' | 'completion' | null): Task =>
    recurrence === current && basis === (task.recurrenceBasis ?? null)
      ? task
      : { ...task, recurrence, recurrenceBasis: recurrence === null ? null : basis };
  if (task.dueDate === null || p.recurrence === null) {
    return current === null && (task.recurrenceBasis ?? null) === null ? task : set(null, null);
  }
  if (p.recurrence !== undefined) {
    const basis = p.recurrenceBasis ?? 'due';
    return set(normalizeRule(p.recurrence, task.dueDate, basis) ?? p.recurrence, basis);
  }
  if (p.recurrenceBasis && current !== null) {
    const basis = p.recurrenceBasis;
    return set(normalizeRule(current, task.dueDate, basis) ?? current, basis);
  }
  return task;
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
  p: Omit<TaskPatch, 'parentId'>,
  now: number,
): ListState {
  const due = touchesDue(p);
  if (p.title === undefined && p.description === undefined && !due && !touchesRecurrence(p)) {
    return state;
  }
  return mapTasks(state, ids, (task) =>
    applyRecurrence(
      {
        ...task,
        ...(p.title === undefined ? {} : { title: p.title }),
        ...(p.description === undefined
          ? {}
          : { description: p.description, hasDescription: hasText(p.description) }),
        ...(due ? dueUnit(p) : {}),
        updatedAt: now,
      },
      p,
    ),
  );
}

/** A single completion (P10): completing a recurring task with `nextId` spawns the next one. */
function completeTask(state: ListState, id: string, p: TaskComplete, ctx: ApplyContext): ListState {
  const task = state.tasks[id];
  const next = completeTasks(state, [id], p.completed, ctx.now);
  if (!task || !p.completed || p.nextId === undefined || task.completedAt !== null) return next;
  return spawnNext(next, task, p.nextId, ctx);
}

/**
 * The completion date of an occurrence (ADR 0049 §1.2): the day of the edit time in the
 * task's `dueTz` for a timed task, otherwise in the actor's timezone (UTC when unknown).
 */
function completionDate(task: Task, ctx: ApplyContext): string {
  const zone = task.dueTime !== null && task.dueTz !== null ? task.dueTz : ctx.timezone;
  try {
    return todayIn(zone ?? 'UTC', ctx.now);
  } catch {
    // An unknown zone name (a stale cache): the UTC day is the best local guess; the server's
    // response replaces the instance anyway.
    return todayIn('UTC', ctx.now);
  }
}

/**
 * The optimistic next instance of a recurring task (FR-REC-3, ADR 0049 §1.4) with the
 * client-chosen `nextId`: the next dates from `nextInstance`, what the list shows copied
 * (title, description, tags, assignee, due time and zone), counts zeroed, directly after the
 * completed task in its group and, for a subtask, as its next sibling. Subtask copies, the
 * reminders' bell and the follower list arrive with the server's response. Idempotent.
 */
function spawnNext(state: ListState, task: Task, nextId: string, ctx: ApplyContext): ListState {
  if (state.tasks[nextId] || state.deletedTasks[nextId]) return state;
  const rule = task.recurrence ?? null;
  if (rule === null || task.dueDate === null) return state;
  const basis = task.recurrenceBasis ?? 'due';
  const next = nextInstance(
    rule,
    basis,
    { dueDate: task.dueDate, startDate: task.startDate },
    completionDate(task, ctx),
  );
  if (next === null) return state;
  let placement = task.placement;
  if (placement) {
    const siblings = placedKeyed(tasksInGroup(state, placement.groupId));
    const [position = placement.position] = keysForIntent(siblings, { afterId: task.id });
    placement = { groupId: placement.groupId, position };
  }
  let subtaskPosition = task.subtaskPosition;
  if (task.parentId !== null) {
    const siblings = subtaskKeyed(childrenOf(state, task.parentId));
    [subtaskPosition = task.subtaskPosition] = keysForIntent(siblings, { afterId: task.id });
  }
  const instance: Task = {
    ...task,
    id: nextId,
    seq: null,
    dueDate: next.dueDate,
    startDate: next.startDate,
    recurrence: next.recurrence,
    recurrenceBasis: basis,
    completedAt: null,
    tagIds: [...task.tagIds],
    counts: noCounts(),
    placement,
    subtaskPosition,
    createdBy: ctx.userId,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    ...(task.nextReminderAt === undefined ? {} : { nextReminderAt: null }),
  };
  return adjustCounts(withTask(state, instance), task.parentId, 1, 0);
}

/** When a reminder spec fires for this task, or null when it cannot be resolved here. */
function fireAtOf(spec: ReminderSpecInput, task: Task, ctx: ReducerContext): number | null {
  if ('at' in spec) return spec.at;
  // An all-day due moment needs the owner's timezone.
  const allDay = task.dueTime === null || task.dueTz === null;
  if (allDay && ctx.timezone === undefined) return null;
  return resolveFireAt(
    { kind: 'relative', offsetMinutes: spec.offsetMinutes, remindAt: null },
    task,
    {
      timezone: ctx.timezone ?? 'UTC',
      allDayReminderTime: ctx.allDayReminderTime ?? DEFAULT_PREFS.allDayReminderTime,
    },
  );
}

function firesOf(
  specs: readonly ReminderSpecInput[],
  task: Task,
  ctx: ReducerContext,
): (number | null)[] {
  return specs.map((spec) => fireAtOf(spec, task, ctx));
}

/** The earliest of the instants (nulls ignored), or `current` when there are none. */
export function earliest(
  current: number | null,
  instants: readonly (number | null)[],
): number | null {
  let min = current;
  for (const at of instants) if (at !== null && (min === null || at < min)) min = at;
  return min;
}

/**
 * The row's bell (FR-REM-4) after the actor adds reminders (`clear` first drops the ones the
 * task had): `nextReminderAt` becomes the earliest pending instant. Dormant reminders (a
 * relative one without a due date) do not count.
 */
function remindTask(
  state: ListState,
  taskId: string,
  specs: readonly ReminderSpecInput[],
  clear: boolean | undefined,
  ctx: ReducerContext,
): ListState {
  const task = state.tasks[taskId];
  if (!task) return state;
  const before = task.nextReminderAt ?? null;
  const nextReminderAt = earliest(clear ? null : before, firesOf(specs, task, ctx));
  return nextReminderAt === before ? state : withTask(state, { ...task, nextReminderAt });
}

function completeTasks(
  state: ListState,
  ids: readonly string[],
  completed: boolean,
  now: number,
): ListState {
  const changed: Task[] = [];
  let next = mapTasks(state, ids, (task) => {
    if ((task.completedAt !== null) === completed) return task;
    changed.push(task);
    return { ...task, completedAt: completed ? now : null, updatedAt: now };
  });
  for (const task of changed) next = adjustCounts(next, task.parentId, 0, completed ? 1 : -1);
  return next;
}

/**
 * Soft delete (05 §4.3): descendants go with the task and are restored with it. A parent
 * loses the deleted child from its counters.
 */
function deleteTasks(state: ListState, ids: readonly string[], withGroupId?: string): ListState {
  const present = new Set(ids.filter((id) => state.tasks[id]));
  if (present.size === 0) return state;
  const index = childrenIndex(Object.values(state.tasks));
  const deletedTasks = { ...state.deletedTasks };
  const gone: string[] = [];
  const cascade = (rootId: string, taskId: string) => {
    for (const child of index.get(taskId) ?? []) {
      if (deletedTasks[child.id]) continue;
      deletedTasks[child.id] = { task: child, withTaskId: rootId };
      gone.push(child.id);
      cascade(rootId, child.id);
    }
  };
  // Roots first: a listed task below another listed task goes with its ancestor's cascade.
  const isRoot = (task: Task) => {
    for (let p = task.parentId; p !== null; p = state.tasks[p]?.parentId ?? null) {
      if (present.has(p)) return false;
    }
    return true;
  };
  const roots = [...present].map((id) => state.tasks[id] as Task).filter(isRoot);
  for (const task of roots) {
    deletedTasks[task.id] = withGroupId === undefined ? { task } : { task, withGroupId };
    gone.push(task.id);
    cascade(task.id, task.id);
  }
  let next: ListState = { ...state, tasks: omit(state.tasks, gone), deletedTasks };
  for (const task of roots) {
    next = adjustCounts(next, task.parentId, -1, task.completedAt === null ? 0 : -1);
  }
  return next;
}

function restoreTasks(state: ListState, ids: readonly string[], userId: string): ListState {
  const present = ids.filter((id) => state.deletedTasks[id]);
  if (present.length === 0) return state;
  const roots = new Set(present);
  const restored = Object.entries(state.deletedTasks)
    .filter(([id, entry]) => roots.has(id) || (entry.withTaskId && roots.has(entry.withTaskId)))
    .map(([id]) => id);
  let next: ListState = { ...state, deletedTasks: omit(state.deletedTasks, restored) };
  for (const id of restored) {
    next = withTask(next, rehome(next, (state.deletedTasks[id] as DeletedTask).task));
  }
  for (const id of present) {
    const task = (state.deletedTasks[id] as DeletedTask).task;
    if (task.parentId !== null && next.deletedTasks[task.parentId]) {
      // ADR 0007 §5: a subtask restored while its parent is still deleted becomes top-level.
      const current = next.tasks[id] as Task;
      const promoted: Task = { ...current, parentId: null, subtaskPosition: null };
      next = withTask(next, {
        ...promoted,
        placement: needsPlacement(promoted, undefined, userId)
          ? (current.placement ?? inboxTop(next))
          : null,
      });
      continue;
    }
    next = adjustCounts(next, task.parentId, 1, task.completedAt === null ? 0 : 1);
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

function applyBulk(state: ListState, op: BulkOp, ctx: ApplyContext): ListState {
  const { now, userId } = ctx;
  switch (op.op) {
    case 'complete':
      return completeTasks(state, op.ids, true, now);
    case 'uncomplete':
      return completeTasks(state, op.ids, false, now);
    case 'delete':
      return deleteTasks(state, op.ids);
    case 'restore':
      return restoreTasks(state, op.ids, userId);
    case 'move':
      return moveTasks(state, op.ids, op.args);
    case 'setDue':
      return patchTasks(state, op.ids, { ...dueUnit(op.args), ...recurrencePart(op.args) }, now);
    case 'addTag':
    case 'removeTag':
      return tagTasks(state, op.ids, op.args.tagId, op.op === 'addTag');
    case 'assign':
      return assignTasks(state, op.ids, op.args.assigneeId, ctx);
  }
}

function tagTasks(
  state: ListState,
  ids: readonly string[],
  tagId: string,
  add: boolean,
): ListState {
  const tasks = { ...state.tasks };
  let changed = false;
  for (const id of ids) {
    const task = tasks[id];
    if (!task || task.tagIds.includes(tagId) === add) continue;
    tasks[id] = {
      ...task,
      tagIds: add ? [...task.tagIds, tagId] : task.tagIds.filter((t) => t !== tagId),
    };
    changed = true;
  }
  return changed ? { ...state, tasks } : state;
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

function restoreGroup(state: ListState, id: string, userId: string): ListState {
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
  return restoreTasks(next, alongside, userId);
}
