import { DEFAULT_PREFS } from '../limits.ts';
import { resolveFireAt } from '../reminders.ts';
import type { FollowState } from '../schemas/collab.ts';
import type { Task, TaskDetail, TaskPatch } from '../schemas/list.ts';
import type { Reminder } from '../schemas/reminders.ts';
import { type ApplyContext, applyOp, earliest, touchesDue } from './apply.ts';
import { mergeResponse } from './merge.ts';
import type { ListOpSpec, ReducerContext, ReminderCreateBody } from './ops.ts';
import { childrenOf, emptyListState, type ListState } from './state.ts';

/**
 * The `['task', id]` cache (GET /tasks/:id) as a small list state: the task and its direct
 * subtasks. Ops then apply to a task detail with the very reducers the list uses, so the pane
 * shows optimistic edits even for tasks that are not in My tasks.
 */
export function detailState(detail: TaskDetail): ListState {
  const {
    subtasks,
    parentChain: _chain,
    followers: _followers,
    attachments: _attachments,
    reminders: _reminders,
    ...task
  } = detail;
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
    followers: detail.followers,
    ...(detail.attachments === undefined ? {} : { attachments: detail.attachments }),
    ...(detail.reminders === undefined ? {} : { reminders: detail.reminders }),
  };
}

/** Applies one op to a task detail (a no-op when the op concerns other tasks). */
export function applyOpToDetail(detail: TaskDetail, op: ListOpSpec, ctx: ApplyContext): TaskDetail {
  if (op.kind === 'task.follow') {
    return op.entityId === detail.id ? follow(detail, ctx.userId, op.payload.following) : detail;
  }
  if (op.kind === 'reminder.create' && op.taskId === detail.id) {
    return addReminder(detail, op.entityId, op.payload, ctx);
  }
  if (op.kind === 'reminder.delete' && op.taskId === detail.id) {
    return withReminders(
      detail,
      detail.reminders?.filter((r) => r.id !== op.entityId),
    );
  }
  const before = detailState(detail);
  const after = applyOp(before, op, ctx);
  if (after === before) return detail;
  const result = toDetail(detail, after);
  return op.kind === 'task.patch' && op.entityId === detail.id
    ? reresolve(result, op.payload, ctx)
    : result;
}

// ---------------------------------------------------------------------------------------------
// P10 reminders (FR-REM, ADR 0049 §2): the detail holds the viewer's reminders, so the pane
// and the row's bell (`nextReminderAt`) follow every reminder op and due change exactly.
// ---------------------------------------------------------------------------------------------

function ownerOf(ctx: ReducerContext) {
  return {
    timezone: ctx.timezone ?? 'UTC',
    allDayReminderTime: ctx.allDayReminderTime ?? DEFAULT_PREFS.allDayReminderTime,
  };
}

/** `fire_at` as the server resolves it; an all-day relative one needs the viewer's timezone. */
function fireAtFor(
  reminder: Pick<Reminder, 'kind' | 'offsetMinutes' | 'remindAt'>,
  task: Task,
  ctx: ReducerContext,
) {
  const allDay = task.dueTime === null || task.dueTz === null;
  if (
    reminder.kind === 'relative' &&
    allDay &&
    task.dueDate !== null &&
    ctx.timezone === undefined
  ) {
    return null;
  }
  return resolveFireAt(reminder, task, ownerOf(ctx));
}

/** Pending first by `fireAt`, then dormant ones (GET /tasks/:id/reminders order). */
function byFireAt(a: Reminder, b: Reminder): number {
  if (a.fireAt === b.fireAt) return a.createdAt - b.createdAt;
  if (a.fireAt === null) return 1;
  if (b.fireAt === null) return -1;
  return a.fireAt - b.fireAt;
}

/** The earliest pending reminder: not fired, and not dormant. */
function nextOf(reminders: readonly Reminder[]): number | null {
  return earliest(
    null,
    reminders.filter((r) => r.firedAt === null).map((r) => r.fireAt),
  );
}

function withReminders(
  detail: TaskDetail,
  reminders: Reminder[] | undefined,
  extra: readonly (number | null)[] = [],
): TaskDetail {
  if (reminders === undefined) return detail;
  const sorted = [...reminders].sort(byFireAt);
  return { ...detail, reminders: sorted, nextReminderAt: earliest(nextOf(sorted), extra) };
}

/** ADR 0049 §2.5: an identical reminder (same offset, or same instant) is not added twice. */
function addReminder(
  detail: TaskDetail,
  id: string,
  body: ReminderCreateBody,
  ctx: ApplyContext,
): TaskDetail {
  const reminders = detail.reminders ?? [];
  const relative = 'offsetMinutes' in body;
  const identical = reminders.some(
    (r) =>
      r.id === id ||
      (relative
        ? r.offsetMinutes === body.offsetMinutes
        : r.kind === 'absolute' && r.remindAt === body.at),
  );
  if (identical) return detail;
  const shape = relative
    ? { kind: 'relative' as const, offsetMinutes: body.offsetMinutes, remindAt: null }
    : { kind: 'absolute' as const, offsetMinutes: null, remindAt: body.at };
  const reminder: Reminder = {
    id,
    taskId: detail.id,
    ...shape,
    fireAt: fireAtFor(shape, detail, ctx),
    firedAt: null,
    createdAt: ctx.now,
  };
  return withReminders(detail, [...reminders, reminder]);
}

/**
 * After a patch of the detail's task: `clearReminders` drops the viewer's reminders, a due
 * change re-resolves the pending relative ones (dormant without a due date, ADR 0049 §2.2),
 * and the bell is the earliest of those and of the `reminders` the patch adds (their rows
 * arrive with the next fetch).
 */
function reresolve(detail: TaskDetail, p: TaskPatch, ctx: ReducerContext): TaskDetail {
  if (detail.reminders === undefined) return detail;
  if (!touchesDue(p) && !p.clearReminders && p.reminders === undefined) return detail;
  const kept = p.clearReminders ? [] : detail.reminders;
  const reminders = touchesDue(p)
    ? kept.map((r) => {
        if (r.kind !== 'relative' || r.firedAt !== null) return r;
        const fireAt = fireAtFor(r, detail, ctx);
        return fireAt === r.fireAt ? r : { ...r, fireAt };
      })
    : kept;
  const added = (p.reminders ?? []).map((spec) =>
    fireAtFor(
      'at' in spec
        ? { kind: 'absolute', offsetMinutes: null, remindAt: spec.at }
        : { kind: 'relative', offsetMinutes: spec.offsetMinutes, remindAt: null },
      detail,
      ctx,
    ),
  );
  return withReminders(detail, reminders, added);
}

/** FR-COL-4: the viewer joins (at the end, in follow order) or leaves the followers. */
function follow(detail: TaskDetail, userId: string, following: boolean): TaskDetail {
  if (detail.followers.includes(userId) === following) return detail;
  return {
    ...detail,
    followers: following
      ? [...detail.followers, userId]
      : detail.followers.filter((id) => id !== userId),
  };
}

const isReminder = (v: unknown): v is Reminder =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as Reminder).id === 'string' &&
  typeof (v as Reminder).kind === 'string' &&
  'fireAt' in v;

const isFollowState = (v: unknown): v is FollowState =>
  typeof v === 'object' &&
  v !== null &&
  Array.isArray((v as { followers?: unknown }).followers) &&
  (v as { followers: unknown[] }).followers.every((id) => typeof id === 'string');

/** Whether `op` concerns the task of a detail or one of its direct subtasks. */
function touches(state: ListState, op: ListOpSpec): boolean {
  switch (op.kind) {
    case 'task.bulk':
      return op.payload.ids.some((id) => id in state.tasks);
    case 'task.create':
      return op.payload.parentId !== undefined && op.payload.parentId in state.tasks;
    case 'comment.patch':
      return false;
    case 'comment.delete':
    case 'comment.restore':
    case 'reminder.create':
    case 'reminder.delete':
      return op.taskId in state.tasks;
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
  if (op.kind === 'task.follow') {
    if (op.entityId !== detail.id) return detail;
    // The server's list of active followers replaces the optimistic guess.
    return isFollowState(response)
      ? { ...detail, followers: response.followers }
      : applyOpToDetail(detail, op, ctx);
  }
  if (op.kind === 'reminder.create' && op.taskId === detail.id) {
    const applied = applyOpToDetail(detail, op, ctx);
    if (!isReminder(response)) return applied;
    // The server's row replaces the optimistic one; for an identical existing reminder it
    // returns that one (another id), so the optimistic row goes.
    const others = (applied.reminders ?? []).filter(
      (r) => r.id !== op.entityId && r.id !== response.id,
    );
    return withReminders(applied, [...others, response]);
  }
  if (op.kind === 'reminder.delete' && op.taskId === detail.id) {
    return applyOpToDetail(detail, op, ctx);
  }
  if (!touches(detailState(detail), op)) return detail;
  const optimistic = applyOpToDetail(detail, op, ctx);
  const applied = detailState(optimistic);
  const merged = mergeResponse(applied, op, response).state;
  const result = toDetail(optimistic, merged);
  const description =
    op.kind === 'task.patch' && op.entityId === detail.id && op.payload.description !== undefined
      ? op.payload.description
      : (applied.tasks[detail.id]?.description ?? detail.description);
  return { ...result, description };
}
