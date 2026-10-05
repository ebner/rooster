import {
  findDateInTitle,
  findGroupToken,
  stripBackticks,
  stripTitleMatch,
  todayIn,
} from '@rooster/core/dates';
import { uuidv7 } from '@rooster/core/ids';
import { compareKeys } from '@rooster/core/ordering';
import {
  type BulkOp,
  type BulkResult,
  isValidTimeZone,
  type MyList,
  type OrderingIntent,
  PAGE_LIMIT_DEFAULT,
  type PageQuery,
  SUBTASK_DEPTH_MAX,
  type SubtaskReorder,
  type Task,
  type TaskCompleteResult,
  type TaskCreate,
  type TaskDetail,
  type TaskDuplicate,
  type TaskMove,
  type TaskMoveResult,
  type TaskPage,
  type TaskPatch,
  type TaskPatchResult,
  type TaskQuery,
  type TrashPage,
} from '@rooster/core/schemas';
import { inSmartView, selectView } from '@rooster/core/views';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import {
  organization,
  placement,
  tag as tagTable,
  task,
  taskExpansion,
  taskGroup,
  taskTag,
  user,
} from '../db/schema/index.ts';
import type { DomainEventType } from '../events/bus.ts';
import { AppError } from '../lib/errors.ts';
import {
  type Actor,
  emitAfterCommit,
  immediate,
  type OpMeta,
  type ServiceDeps,
  type Tx,
} from './context.ts';
import {
  memberIds,
  mergeReach,
  qk,
  selfAudience,
  type TaskReach,
  taskAudiences,
  taskReach,
} from './event-audience.ts';
import { listGroups } from './group-service.ts';
import {
  ancestorsOf,
  chunked,
  clockAllows,
  descendantsOf,
  type GroupRow,
  inboxOf,
  liveTasksById,
  loadTaskExtras,
  type PlacementRow,
  parseClock,
  placementOf,
  placementsFor,
  posClockKey,
  requireOwnGroup,
  requireTask,
  softDeleteTasks,
  subtaskDomain,
  subtreeHeight,
  type TaskRow,
  taskDeleted,
  taskDtoFor,
  taskDtos,
  taskNotFound,
  toGroupDto,
  toTaskDto,
} from './list-access.ts';
import type { OrderingService, OrderTarget } from './ordering-service.ts';
import { requireMembership } from './org-access.ts';
import type { MemberRemovalStep } from './org-service.ts';
import type { PlacementService, PlacementTarget } from './placement-service.ts';
import { indexTasks } from './search-index.ts';
import type { SearchService } from './search-service.ts';
import { attachTags, emitTaskTagged, resolveTagsForCreate, setTaskTag } from './tag-service.ts';

const DAY_MS = 86_400_000;
/** my-list includes tasks completed within the last 14 days by default (06 §2.3). */
export const COMPLETED_WINDOW_MS = 14 * DAY_MS;

const DUE_KEYS = ['dueDate', 'dueTime', 'dueTz', 'startDate'] as const;

interface DueUnit {
  dueDate: string | null;
  dueTime: string | null;
  dueTz: string | null;
  startDate: string | null;
}

/**
 * The due unit as stored (05 §4.4): absent members are null, and a timezone is kept only
 * together with a time. The whole unit is validated here, not only by the route schema,
 * because bulk `setDue`, `parse: true` and other service callers bypass it: an unknown
 * timezone or a start date without (or after) the due date is a 422, never a CHECK 5xx.
 */
function dueUnit(
  input: {
    [K in (typeof DUE_KEYS)[number]]?: string | null | undefined;
  },
): DueUnit {
  const dueDate = input.dueDate ?? null;
  const dueTime = dueDate === null ? null : (input.dueTime ?? null);
  const dueTz = dueTime === null ? null : (input.dueTz ?? null);
  if (dueTime !== null && (dueTz === null || !isValidTimeZone(dueTz))) {
    throw new AppError('validation_failed', 422, 'A due time needs a valid timezone.', [
      { path: 'dueTz', message: 'Expected an IANA timezone such as Europe/Stockholm' },
    ]);
  }
  const startDate = input.startDate ?? null;
  // ISO dates compare correctly as strings (05 §3 CHECK task_start_before_due).
  if (startDate !== null && (dueDate === null || startDate > dueDate)) {
    throw new AppError(
      'validation_failed',
      422,
      'A start date needs a due date and must not be after it.',
      [{ path: 'startDate', message: 'Expected a date on or before the due date' }],
    );
  }
  return { dueDate, dueTime, dueTz, startDate };
}

function hasDue(input: object): boolean {
  return DUE_KEYS.some((k) => k in input && (input as Record<string, unknown>)[k] !== undefined);
}

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor<T>(cursor: string | undefined, check: (v: unknown) => v is T): T | null {
  if (cursor === undefined) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (check(value)) return value;
  } catch {
    // Reported below.
  }
  throw new AppError('validation_failed', 422, 'Invalid cursor.', [
    { path: 'cursor', message: 'Pass back nextCursor unchanged' },
  ]);
}

const isTrashCursor = (v: unknown): v is [number, string] =>
  Array.isArray(v) && typeof v[0] === 'number' && typeof v[1] === 'string';
const invalidParent = (detail: string) =>
  new AppError('invalid_parent', 422, detail, [{ path: 'parentId', message: detail }]);

const isOffsetCursor = (v: unknown): v is { o: number } =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as { o?: unknown }).o === 'number' &&
  Number.isInteger((v as { o: number }).o) &&
  (v as { o: number }).o >= 0;

/** Member removal (05 §4.2 step 3): the leaving member's expansions in that org go too. */
export const expansionRemovalStep: MemberRemovalStep = (tx, { orgId, userId }) => {
  const ids = tx
    .select({ id: task.id })
    .from(taskExpansion)
    .innerJoin(task, eq(task.id, taskExpansion.taskId))
    .where(and(eq(taskExpansion.userId, userId), eq(task.orgId, orgId)))
    .all()
    .map((r) => r.id);
  for (const chunk of chunked(ids)) {
    tx.delete(taskExpansion)
      .where(and(eq(taskExpansion.userId, userId), inArray(taskExpansion.taskId, chunk)))
      .run();
  }
};

/** Tasks (FR-TASK, 05 §4.3) and the actor's list reads. Authorisation is org membership. */
export class TaskService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly placements: PlacementService,
    private readonly ordering: OrderingService,
    private readonly search: SearchService,
  ) {}

  private now(): number {
    return this.deps.clock();
  }

  /**
   * Publishes a task change after commit (04 §4.5) to everyone who can see the tasks. Pass
   * `before` (the reach captured before a structural change) so users who lost the task from
   * their list hear about it too.
   */
  private emit(
    tx: Tx,
    actor: Actor,
    type: DomainEventType,
    orgId: string,
    taskIds: readonly string[],
    options: { before?: TaskReach; trash?: boolean; tags?: boolean } = {},
  ): void {
    const after = taskReach(tx, taskIds);
    const reach = options.before === undefined ? after : mergeReach(options.before, after);
    const audiences = taskAudiences(tx, {
      orgId,
      actorId: actor.userId,
      reach,
      trash: options.trash === true,
    });
    if (options.tags === true) {
      audiences.push({ org: orgId, userIds: memberIds(tx, orgId), keys: [qk.tags(orgId)] });
    }
    emitAfterCommit(this.deps, tx, {
      type,
      orgId,
      actorId: actor.userId,
      subjects: [...taskIds],
      audiences,
    });
  }

  /** A change only the actor sees: their own placements or expansions. */
  private emitOwn(
    tx: Tx,
    actor: Actor,
    type: DomainEventType,
    orgId: string,
    taskIds: readonly string[],
    keys = [qk.myList(orgId), ...taskIds.map(qk.task)],
  ): void {
    emitAfterCommit(this.deps, tx, {
      type,
      orgId,
      actorId: actor.userId,
      subjects: [...taskIds],
      audiences: [selfAudience(actor.userId, orgId, keys)],
    });
  }

  // --- create -------------------------------------------------------------------------------

  /**
   * Creates a task. A top-level task is assigned to the actor and placed in their list: in
   * `groupId` (default the Inbox) at the intent; without any intent it goes to the top of the
   * Inbox, or the end of a named group. With `parentId` it is a subtask (same org, depth ≤ 5)
   * assigned to the parent's assignee, placed among its siblings at the intent (default: the
   * end). A repeated create with the same client `id` and content returns the existing task;
   * the same `id` with other content is `409 id_conflict`.
   */
  create(actor: Actor, orgRef: string, input: TaskCreate, meta?: OpMeta): Task {
    return immediate(this.deps.db, (tx) => {
      const { org } = requireMembership(tx, actor.userId, orgRef);
      const fields = input.parse === true ? this.parseTitle(tx, actor, org.id, input) : input;
      const due = dueUnit(fields);
      const description = fields.description ?? '';

      if (input.id !== undefined) {
        const existing = tx.select().from(task).where(eq(task.id, input.id)).get();
        if (existing !== undefined) {
          const same =
            existing.orgId === org.id &&
            existing.createdBy === actor.userId &&
            existing.parentId === (input.parentId ?? null) &&
            existing.title === fields.title &&
            existing.description === description &&
            existing.dueDate === due.dueDate &&
            existing.dueTime === due.dueTime &&
            existing.dueTz === due.dueTz &&
            existing.startDate === due.startDate;
          if (!same) throw new AppError('id_conflict', 409, 'That ID is already in use.');
          return taskDtoFor(tx, actor.userId, existing);
        }
      }

      const now = this.now();
      const parent =
        input.parentId === undefined
          ? null
          : this.requireParent(tx, actor, org.id, input.parentId, null);
      const intent: OrderingIntent = {};
      if ('afterId' in input) intent.afterId = input.afterId ?? null;
      if ('beforeId' in input) intent.beforeId = input.beforeId ?? null;
      const group =
        parent !== null
          ? null
          : fields.groupId === undefined
            ? inboxOf(tx, actor.userId, org.id)
            : requireOwnGroup(tx, actor.userId, fields.groupId, { orgId: org.id });
      const tagIds = resolveTagsForCreate(tx, {
        orgId: org.id,
        ...(input.tagIds === undefined ? {} : { tagIds: input.tagIds }),
        ...(input.tagNames === undefined ? {} : { tagNames: input.tagNames }),
        now,
      });
      const row = this.insertTask(tx, {
        id: input.id ?? uuidv7(),
        orgId: org.id,
        parentId: parent?.id ?? null,
        subtaskPosition:
          parent === null
            ? null
            : this.siblingKey(
                tx,
                parent.id,
                'afterId' in intent || 'beforeId' in intent ? intent : 'end',
              ),
        title: fields.title,
        description,
        // A subtask belongs to whoever owns its parent, so it stays inside the parent's row
        // instead of becoming an orphan (05 §4.1).
        assigneeId: parent === null ? actor.userId : parent.assigneeId,
        createdBy: actor.userId,
        ...due,
        now,
      });
      attachTags(tx, row.id, tagIds, meta?.editTime ?? now);
      this.placements.reconcilePlacements(
        tx,
        [row.id],
        group === null ? undefined : { userId: actor.userId, group, intent },
      );
      this.emit(tx, actor, 'task.created', org.id, [row.id], {
        tags: (input.tagNames?.length ?? 0) > 0,
      });
      return taskDtoFor(tx, actor.userId, row);
    });
  }

  /** Inserts a task row with the next org sequence number and fresh clocks. */
  private insertTask(
    tx: Tx,
    input: Pick<
      TaskRow,
      | 'id'
      | 'orgId'
      | 'parentId'
      | 'subtaskPosition'
      | 'title'
      | 'description'
      | 'assigneeId'
      | 'createdBy'
      | 'dueDate'
      | 'dueTime'
      | 'dueTz'
      | 'startDate'
    > &
      Partial<Pick<TaskRow, 'recurrence' | 'recurrenceBasis'>> & { now: number },
  ): TaskRow {
    const seq = tx
      .update(organization)
      .set({ taskSeq: sql`${organization.taskSeq} + 1` })
      .where(eq(organization.id, input.orgId))
      .returning({ taskSeq: organization.taskSeq })
      .get();
    const { now, ...fields } = input;
    const row: TaskRow = {
      ...fields,
      seq: seq?.taskSeq ?? null,
      recurrence: input.recurrence ?? null,
      recurrenceBasis: input.recurrenceBasis ?? null,
      seriesId: null,
      completedAt: null,
      completedBy: null,
      fieldClock: '{}',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedBy: null,
    };
    tx.insert(task).values(row).run();
    indexTasks(tx, [row.id]);
    return row;
  }

  /** A fractional key among the subtasks of `parentId` (04 §7), excluding `exclude`. */
  private siblingKey(
    tx: Tx,
    parentId: string,
    target: OrderTarget,
    exclude: readonly string[] = [],
  ): string {
    const domain = subtaskDomain(tx, { parentId, now: this.now() }, exclude);
    const [key] = this.ordering.place(domain, target).keys;
    return key as string;
  }

  /**
   * The parent for a create or re-parent (05 §4.3): a live task of the same org, not the
   * task itself or one of its descendants (`422 subtask_cycle`), and shallow enough that the
   * moved subtree stays within SUBTASK_DEPTH_MAX ancestors (`422 subtask_depth`). An unknown
   * or invisible parent is `422 invalid_parent`; a deleted one `410`.
   */
  private requireParent(
    tx: Tx,
    actor: Actor,
    orgId: string,
    parentId: string,
    moving: TaskRow | null,
  ): TaskRow {
    let parent: TaskRow;
    try {
      parent = requireTask(tx, actor.userId, parentId);
    } catch (err) {
      if (err instanceof AppError && err.status === 404) {
        throw invalidParent('The parent task does not exist.');
      }
      throw err;
    }
    if (parent.orgId !== orgId) {
      throw invalidParent('A subtask must be in the same organisation as its parent.');
    }
    if (parent.deletedAt !== null) {
      throw new AppError('conflict_deleted', 410, 'The parent task is deleted.');
    }
    const ancestors = ancestorsOf(tx, parent);
    if (moving !== null && (parent.id === moving.id || ancestors.some((a) => a.id === moving.id))) {
      throw new AppError(
        'subtask_cycle',
        422,
        'A task cannot become a subtask of itself or of its own subtasks.',
        [{ path: 'parentId', message: 'The parent is the task or one of its subtasks' }],
      );
    }
    const depth = ancestors.length + 1 + (moving === null ? 0 : subtreeHeight(tx, moving.id));
    if (depth > SUBTASK_DEPTH_MAX) {
      throw new AppError(
        'subtask_depth',
        422,
        `Subtasks can be nested at most ${SUBTASK_DEPTH_MAX} levels deep.`,
        [{ path: 'parentId', message: `Depth would be ${depth}` }],
      );
    }
    return parent;
  }

  /**
   * `parse: true` (CLI, MCP): a trailing `>Group` token picks the actor's group by
   * case-insensitive name prefix, and the last date phrase becomes the due date, both in
   * the actor's locale, timezone and week start. Explicit body fields win.
   */
  private parseTitle(tx: Tx, actor: Actor, orgId: string, input: TaskCreate): TaskCreate {
    const settings = tx
      .select({
        locale: user.locale,
        timezone: user.timezone,
        weekStart: user.weekStart,
        dateFormat: user.dateFormat,
      })
      .from(user)
      .where(eq(user.id, actor.userId))
      .get();
    const timezone = settings?.timezone ?? 'UTC';
    let title = input.title;
    let groupId = input.groupId;
    const token = findGroupToken(title);
    if (token !== null) {
      const wanted = token.name.toLowerCase();
      const groups = listGroups(tx, actor.userId, orgId);
      const match =
        groups.find((g) => g.name.toLowerCase() === wanted) ??
        groups.find((g) => g.name.toLowerCase().startsWith(wanted));
      if (match !== undefined) {
        groupId ??= match.id;
        title = `${title.slice(0, token.start)} ${title.slice(token.end)}`;
      }
    }
    const result: TaskCreate = { ...input, ...(groupId === undefined ? {} : { groupId }) };
    const date = hasDue(input)
      ? null
      : findDateInTitle(title, {
          today: todayIn(timezone, this.now()),
          locale: settings?.locale === 'sv' ? 'sv' : 'en',
          weekStart: settings?.weekStart === 0 ? 0 : 1,
          dateFormat: settings?.dateFormat === 'd MMM' ? 'd MMM' : 'MMM d',
        });
    if (date !== null) {
      title = stripTitleMatch(title, date);
      result.dueDate = date.date;
      result.dueTime = date.time;
      result.dueTz = date.time === null ? null : timezone;
    } else {
      title = stripBackticks(title).replace(/\s+/g, ' ').trim();
    }
    if (title === '') {
      throw new AppError('validation_failed', 422, 'The title is empty after parsing.', [
        { path: 'title', message: 'Nothing left besides tokens' },
      ]);
    }
    result.title = title;
    return result;
  }

  // --- edits --------------------------------------------------------------------------------

  /** Live (not deleted) task the actor may edit. */
  private requireLive(tx: Tx, actor: Actor, taskId: string): TaskRow {
    const row = requireTask(tx, actor.userId, taskId);
    if (row.deletedAt !== null) throw taskDeleted();
    return row;
  }

  /**
   * Partial update with per-field LWW (04 §6.2): a field applies when the edit time is not
   * older than its clock. The due unit (with the start date) is one field, and so is the
   * parent (`parent_id` with `subtask_position`, 05 §4.4). Skipped fields are listed in
   * `ignoredFields`. Re-parenting appends to the new parent's subtasks; `parentId: null`
   * makes the task top-level, which places it at the top of its assignee's Inbox.
   */
  patch(actor: Actor, taskId: string, input: TaskPatch, meta: OpMeta): TaskPatchResult {
    return immediate(this.deps.db, (tx) => {
      const row = this.requireLive(tx, actor, taskId);
      return this.applyPatch(tx, actor, row, input, meta);
    });
  }

  private applyPatch(
    tx: Tx,
    actor: Actor,
    row: TaskRow,
    input: TaskPatch,
    meta: OpMeta,
  ): TaskPatchResult {
    const clock = parseClock(row.fieldClock);
    const changes: Partial<TaskRow> = {};
    const ignoredFields: string[] = [];
    let applied = false;
    const before =
      input.parentId !== undefined && input.parentId !== row.parentId
        ? taskReach(tx, [row.id])
        : undefined;
    const apply = (key: string, fields: string[], set: () => void) => {
      if (clockAllows(clock, key, meta.editTime)) {
        set();
        clock[key] = meta.editTime;
        applied = true;
      } else {
        ignoredFields.push(...fields);
      }
    };
    if (input.title !== undefined) {
      const title = input.title;
      apply('title', ['title'], () => {
        changes.title = title;
      });
    }
    if (input.description !== undefined) {
      const description = input.description;
      apply('description', ['description'], () => {
        changes.description = description;
      });
    }
    if (hasDue(input)) {
      const due = dueUnit(input);
      apply(
        'due',
        DUE_KEYS.filter((k) => input[k] !== undefined),
        () => Object.assign(changes, due),
      );
    }
    let reparented = false;
    const parentId = input.parentId;
    if (parentId !== undefined && parentId !== row.parentId) {
      apply('parent', ['parentId'], () => {
        if (parentId === null) {
          changes.parentId = null;
          changes.subtaskPosition = null;
        } else {
          const parent = this.requireParent(tx, actor, row.orgId, parentId, row);
          changes.parentId = parent.id;
          changes.subtaskPosition = this.siblingKey(tx, parent.id, 'end');
        }
        reparented = true;
      });
    }
    if (applied) {
      const next = { ...changes, fieldClock: JSON.stringify(clock), updatedAt: this.now() };
      tx.update(task).set(next).where(eq(task.id, row.id)).run();
      Object.assign(row, next);
      if (changes.title !== undefined || changes.description !== undefined) {
        indexTasks(tx, [row.id]);
      }
    }
    if (reparented) this.placements.reconcilePlacements(tx, [row.id]);
    if (applied) {
      this.emit(tx, actor, 'task.updated', row.orgId, [row.id], before ? { before } : {});
    }
    return { task: taskDtoFor(tx, actor.userId, row), ignoredFields };
  }

  /** Completes or reopens (LWW key `completed`). The placement is kept (05 §4.1). */
  complete(actor: Actor, taskId: string, completed: boolean, meta: OpMeta): TaskCompleteResult {
    return immediate(this.deps.db, (tx) => {
      const row = this.requireLive(tx, actor, taskId);
      this.applyComplete(tx, actor, row, completed, meta);
      return { task: taskDtoFor(tx, actor.userId, row) };
    });
  }

  private applyComplete(
    tx: Tx,
    actor: Actor,
    row: TaskRow,
    completed: boolean,
    meta: OpMeta,
  ): void {
    const clock = parseClock(row.fieldClock);
    if (!clockAllows(clock, 'completed', meta.editTime)) return;
    clock.completed = meta.editTime;
    const changes: Partial<TaskRow> = {
      fieldClock: JSON.stringify(clock),
      updatedAt: this.now(),
    };
    if (completed && row.completedAt === null) {
      // The edit time is when the user completed it, which matters for offline replays.
      changes.completedAt = meta.editTime;
      changes.completedBy = actor.userId;
    } else if (!completed) {
      changes.completedAt = null;
      changes.completedBy = null;
    }
    tx.update(task).set(changes).where(eq(task.id, row.id)).run();
    Object.assign(row, changes);
    this.emit(tx, actor, 'task.completed', row.orgId, [row.id]);
  }

  /**
   * Soft delete with descendants (05 §4.3). The placement stays so a restore returns the task
   * to its exact slot. Deleting a deleted task is a no-op.
   */
  remove(actor: Actor, taskId: string, meta: OpMeta): void {
    immediate(this.deps.db, (tx) => {
      const row = requireTask(tx, actor.userId, taskId);
      this.applyDelete(tx, actor, row, meta);
    });
  }

  private applyDelete(tx: Tx, actor: Actor, row: TaskRow, meta: OpMeta): void {
    if (row.deletedAt !== null) return;
    const clock = parseClock(row.fieldClock);
    if (!clockAllows(clock, 'deleted', meta.editTime)) return;
    clock.deleted = meta.editTime;
    tx.update(task)
      .set({ fieldClock: JSON.stringify(clock) })
      .where(eq(task.id, row.id))
      .run();
    softDeleteTasks(tx, [row.id], { userId: actor.userId, now: this.now() });
    this.emit(tx, actor, 'task.deleted', row.orgId, [row.id], { trash: true });
  }

  /**
   * Undoes a delete (or restores from Trash) with the descendants deleted together with it.
   * A placement whose group is gone moves to the top of its user's Inbox (05 §4.1).
   */
  restore(actor: Actor, taskId: string, meta: OpMeta): Task {
    return immediate(this.deps.db, (tx) => {
      const row = requireTask(tx, actor.userId, taskId);
      this.applyRestore(tx, actor, row, meta);
      return taskDtoFor(tx, actor.userId, { ...row, ...this.reload(tx, row.id) });
    });
  }

  private reload(tx: Tx, taskId: string): TaskRow {
    const row = tx.select().from(task).where(eq(task.id, taskId)).get();
    if (row === undefined) throw taskNotFound();
    return row;
  }

  private applyRestore(tx: Tx, actor: Actor, row: TaskRow, meta: OpMeta): void {
    if (row.deletedAt === null) return;
    const clock = parseClock(row.fieldClock);
    if (!clockAllows(clock, 'deleted', meta.editTime)) return;
    clock.deleted = meta.editTime;
    const ids = [row.id, ...descendantsOf(tx, [row.id], { deletedAt: row.deletedAt })];
    const now = this.now();
    tx.update(task)
      .set({ deletedAt: null, deletedBy: null, updatedAt: now })
      .where(inArray(task.id, ids))
      .run();
    indexTasks(tx, ids);
    tx.update(task)
      .set({ fieldClock: JSON.stringify(clock) })
      .where(eq(task.id, row.id))
      .run();
    // A subtask deleted on its own, whose parent was deleted later, comes back top-level:
    // it cannot live under a parent in Trash.
    const parent = row.parentId === null ? undefined : this.reload(tx, row.parentId);
    if (parent !== undefined && parent.deletedAt !== null) {
      clock.parent = meta.editTime;
      tx.update(task)
        .set({ parentId: null, subtaskPosition: null, fieldClock: JSON.stringify(clock) })
        .where(eq(task.id, row.id))
        .run();
      this.placements.reconcilePlacements(tx, [row.id]);
    }
    const orphaned = tx
      .select({ taskId: placement.taskId, userId: placement.userId, orgId: placement.orgId })
      .from(placement)
      .innerJoin(taskGroup, eq(taskGroup.id, placement.groupId))
      .where(and(inArray(placement.taskId, ids), isNotNull(taskGroup.deletedAt)))
      .all();
    for (const p of orphaned) this.placements.rehomeToInbox(tx, p.userId, p.orgId, [p.taskId]);
    this.emit(tx, actor, 'task.restored', row.orgId, [row.id], { trash: true });
  }

  /** Hard delete, only from Trash. Placements and subtasks go with it (FK cascade). */
  removePermanently(actor: Actor, taskId: string, _meta?: OpMeta): void {
    immediate(this.deps.db, (tx) => {
      const row = requireTask(tx, actor.userId, taskId);
      if (row.deletedAt === null) {
        throw new AppError('not_in_trash', 409, 'Only deleted tasks can be deleted permanently.');
      }
      const before = taskReach(tx, [row.id]);
      const gone = [row.id, ...descendantsOf(tx, [row.id])];
      tx.delete(task).where(eq(task.id, row.id)).run();
      indexTasks(tx, gone);
      this.emit(tx, actor, 'task.purged', row.orgId, [row.id], { before, trash: true });
    });
  }

  // --- placement moves ----------------------------------------------------------------------

  /** Moves the actor's placement (LWW key `pos:<userId>`); 404 if not in the actor's list. */
  move(actor: Actor, taskId: string, input: TaskMove, meta: OpMeta): TaskMoveResult {
    return immediate(this.deps.db, (tx) => {
      const row = this.requireLive(tx, actor, taskId);
      const current = this.requirePlacement(tx, actor, row);
      const group = requireOwnGroup(tx, actor.userId, input.groupId, { orgId: row.orgId });
      const [result] = this.movePlacements(tx, actor, group, [row], input, meta);
      return { placement: result ?? { groupId: current.groupId, position: current.position } };
    });
  }

  private requirePlacement(tx: Tx, actor: Actor, row: TaskRow) {
    const current = placementOf(tx, row.id);
    if (current === undefined || current.userId !== actor.userId) throw taskNotFound();
    return current;
  }

  /**
   * Places `rows` consecutively at the intent in `group`, in the given order. Rows whose
   * position clock is newer than the edit keep their placement.
   */
  private movePlacements(
    tx: Tx,
    actor: Actor,
    group: GroupRow,
    rows: TaskRow[],
    intent: OrderingIntent,
    meta: OpMeta,
  ): ({ groupId: string; position: string } | null)[] {
    const key = posClockKey(actor.userId);
    const movable = rows.filter((r) => clockAllows(parseClock(r.fieldClock), key, meta.editTime));
    if (movable.length === 0) return rows.map(() => null);
    const target: OrderTarget = {
      ...(intent.afterId === undefined ? {} : { afterId: intent.afterId }),
      ...(intent.beforeId === undefined ? {} : { beforeId: intent.beforeId }),
    };
    const keys = this.placements.placeInGroup(tx, {
      userId: actor.userId,
      group,
      taskIds: movable.map((r) => r.id),
      target,
    });
    const now = this.now();
    const byId = new Map<string, string>();
    movable.forEach((r, i) => {
      const clock = parseClock(r.fieldClock);
      clock[key] = meta.editTime;
      tx.update(task)
        .set({ fieldClock: JSON.stringify(clock), updatedAt: now })
        .where(eq(task.id, r.id))
        .run();
      byId.set(r.id, keys[i] as string);
    });
    this.emitOwn(
      tx,
      actor,
      'task.moved',
      group.orgId,
      movable.map((r) => r.id),
    );
    return rows.map((r) => {
      const position = byId.get(r.id);
      return position === undefined ? null : { groupId: group.id, position };
    });
  }

  // --- bulk ---------------------------------------------------------------------------------

  /**
   * Bulk operations (06 §2.4): atomic per task, not across tasks. `move` places the movable
   * tasks consecutively at the target in the given order.
   */
  bulk(actor: Actor, op: BulkOp, meta: OpMeta): BulkResult {
    const ids = [...new Set(op.ids)];
    if (op.op === 'move') return this.bulkMove(actor, ids, op.args, meta);
    const results = ids.map((id) => {
      try {
        immediate(this.deps.db, (tx) => {
          switch (op.op) {
            case 'complete':
            case 'uncomplete':
              this.applyComplete(
                tx,
                actor,
                this.requireLive(tx, actor, id),
                op.op === 'complete',
                meta,
              );
              break;
            case 'delete':
              this.applyDelete(tx, actor, requireTask(tx, actor.userId, id), meta);
              break;
            case 'restore':
              this.applyRestore(tx, actor, requireTask(tx, actor.userId, id), meta);
              break;
            case 'addTag':
            case 'removeTag': {
              const { row, changed } = setTaskTag(tx, {
                userId: actor.userId,
                taskId: id,
                tagId: op.args.tagId,
                on: op.op === 'addTag',
                now: this.now(),
                addedAt: meta.editTime,
              });
              if (changed) emitTaskTagged(this.deps, tx, actor, row);
              break;
            }
            case 'setDue': {
              const due = dueUnit(op.args);
              const patch: TaskPatch = { ...due };
              this.applyPatch(tx, actor, this.requireLive(tx, actor, id), patch, meta);
              break;
            }
          }
        });
        return { id, ok: true };
      } catch (err) {
        if (err instanceof AppError) return { id, ok: false, code: err.code };
        throw err;
      }
    });
    return { results };
  }

  private bulkMove(actor: Actor, ids: string[], args: TaskMove, meta: OpMeta): BulkResult {
    return immediate(this.deps.db, (tx) => {
      const failures = new Map<string, string>();
      const rows: TaskRow[] = [];
      let group: GroupRow | null = null;
      for (const id of ids) {
        try {
          const row = this.requireLive(tx, actor, id);
          this.requirePlacement(tx, actor, row);
          group ??= requireOwnGroup(tx, actor.userId, args.groupId, { orgId: row.orgId });
          if (group.orgId !== row.orgId) throw taskNotFound();
          rows.push(row);
        } catch (err) {
          if (!(err instanceof AppError)) throw err;
          failures.set(id, err.code);
        }
      }
      if (group !== null && rows.length > 0) {
        this.movePlacements(tx, actor, group, rows, args, meta);
      }
      return {
        results: ids.map((id) => {
          const code = failures.get(id);
          return code === undefined ? { id, ok: true } : { id, ok: false, code };
        }),
      };
    });
  }

  // --- subtasks, duplicate, expansion (P3) -------------------------------------------------

  /**
   * Reorders a subtask among its siblings (LWW key `parent`). A newer clock keeps the current
   * position, which is returned like any other result.
   */
  reorder(actor: Actor, taskId: string, input: SubtaskReorder, meta: OpMeta) {
    return immediate(this.deps.db, (tx) => {
      const row = this.requireLive(tx, actor, taskId);
      if (row.parentId === null || row.subtaskPosition === null) {
        throw new AppError('not_subtask', 409, 'Only subtasks can be reordered among siblings.');
      }
      const clock = parseClock(row.fieldClock);
      if (!clockAllows(clock, 'parent', meta.editTime)) {
        return { subtaskPosition: row.subtaskPosition };
      }
      clock.parent = meta.editTime;
      const target: OrderTarget = {
        ...(input.afterId === undefined ? {} : { afterId: input.afterId }),
        ...(input.beforeId === undefined ? {} : { beforeId: input.beforeId }),
      };
      const subtaskPosition = this.siblingKey(tx, row.parentId, target, [row.id]);
      tx.update(task)
        .set({ subtaskPosition, fieldClock: JSON.stringify(clock), updatedAt: this.now() })
        .where(eq(task.id, row.id))
        .run();
      this.emit(tx, actor, 'task.updated', row.orgId, [row.id]);
      return { subtaskPosition };
    });
  }

  /**
   * Duplicate (FR-TASK-13): copies title, description, the due unit and tags, and with
   * `includeSubtasks` every live subtask recursively (reopened, same sibling order). The
   * copies get new sequence numbers; each is assigned like a create (top-level: the actor;
   * subtask: its parent's assignee). A top-level copy goes directly below the original in the
   * actor's group (top of the Inbox if the original is not in the actor's list); a subtask
   * copy directly below the original among its siblings. A repeated call with the same `id`
   * returns the copy.
   */
  duplicate(actor: Actor, taskId: string, input: TaskDuplicate, _meta?: OpMeta): Task {
    return immediate(this.deps.db, (tx) => {
      const source = this.requireLive(tx, actor, taskId);
      if (input.id !== undefined) {
        const existing = tx.select().from(task).where(eq(task.id, input.id)).get();
        if (existing !== undefined) {
          const same =
            existing.orgId === source.orgId &&
            existing.createdBy === actor.userId &&
            existing.parentId === source.parentId &&
            existing.title === source.title;
          if (!same) throw new AppError('id_conflict', 409, 'That ID is already in use.');
          return taskDtoFor(tx, actor.userId, existing);
        }
      }
      const now = this.now();
      const parent = source.parentId === null ? null : this.reload(tx, source.parentId);
      const copyOf = (
        from: TaskRow,
        id: string,
        under: TaskRow | null,
        subtaskPosition: string | null,
      ): TaskRow => {
        const row = this.insertTask(tx, {
          id,
          orgId: from.orgId,
          parentId: under?.id ?? null,
          subtaskPosition,
          title: from.title,
          description: from.description,
          assigneeId: under === null ? actor.userId : under.assigneeId,
          createdBy: actor.userId,
          dueDate: from.dueDate,
          dueTime: from.dueTime,
          dueTz: from.dueTz,
          startDate: from.startDate,
          recurrence: from.recurrence,
          recurrenceBasis: from.recurrenceBasis,
          now,
        });
        const tags = tx
          .select({ tagId: taskTag.tagId })
          .from(taskTag)
          .where(eq(taskTag.taskId, from.id))
          .orderBy(asc(taskTag.addedAt), sql`${taskTag}.rowid`)
          .all()
          .map((t) => t.tagId);
        attachTags(tx, row.id, tags, now);
        return row;
      };
      const top = copyOf(
        source,
        input.id ?? uuidv7(),
        parent,
        parent === null ? null : this.siblingKey(tx, parent.id, { afterId: source.id }),
      );
      // An omitted body skips schema defaults, so absent means "include".
      if (input.includeSubtasks !== false) {
        let frontier: [TaskRow, TaskRow][] = [[source, top]];
        while (frontier.length > 0) {
          const next: [TaskRow, TaskRow][] = [];
          for (const [from, to] of frontier) {
            const children = tx
              .select()
              .from(task)
              .where(and(eq(task.parentId, from.id), isNull(task.deletedAt)))
              .orderBy(asc(task.subtaskPosition), asc(task.id))
              .all();
            for (const child of children) {
              // The new parent's domain is empty, so the original keys keep the order.
              next.push([child, copyOf(child, uuidv7(), to, child.subtaskPosition)]);
            }
          }
          frontier = next;
        }
      }
      let target: PlacementTarget | undefined;
      const place = parent === null ? placementOf(tx, source.id) : undefined;
      if (place !== undefined && place.userId === actor.userId) {
        const group = tx.select().from(taskGroup).where(eq(taskGroup.id, place.groupId)).get();
        if (group !== undefined && group.deletedAt === null) {
          target = { userId: actor.userId, group, intent: { afterId: source.id } };
        }
      }
      this.placements.reconcilePlacements(tx, [top.id], target);
      this.emit(tx, actor, 'task.created', top.orgId, [top.id]);
      return taskDtoFor(tx, actor.userId, top);
    });
  }

  /**
   * Persists the actor's expansion of a parent row (FR-TASK-11). Idempotent; any task the
   * actor can see. Expanding a deleted task is `410`; collapsing always succeeds. Expansion
   * is per-user view state with set semantics and no field clock (05 §4.4 lists none), so
   * the edit time is not consulted: the last arrival wins.
   */
  setExpanded(actor: Actor, taskId: string, expanded: boolean): void {
    immediate(this.deps.db, (tx) => {
      const row = requireTask(tx, actor.userId, taskId);
      let changes: number;
      if (expanded) {
        if (row.deletedAt !== null) throw taskDeleted();
        changes = tx
          .insert(taskExpansion)
          .values({ userId: actor.userId, taskId: row.id })
          .onConflictDoNothing()
          .run().changes;
      } else {
        changes = tx
          .delete(taskExpansion)
          .where(and(eq(taskExpansion.userId, actor.userId), eq(taskExpansion.taskId, row.id)))
          .run().changes;
      }
      if (changes > 0) {
        this.emitOwn(tx, actor, 'task.expanded', row.orgId, [row.id], [qk.myList(row.orgId)]);
      }
    });
  }

  /**
   * The full task (06 §2.4): description, live direct subtasks in sibling order and the
   * parent chain (root first). A deleted task is returned with `deletedAt` (Trash).
   */
  detail(actor: Actor, taskId: string): TaskDetail {
    return immediate(this.deps.db, (tx) => {
      const row = requireTask(tx, actor.userId, taskId);
      const subtasks = tx
        .select()
        .from(task)
        .where(and(eq(task.parentId, row.id), isNull(task.deletedAt)))
        .orderBy(asc(task.subtaskPosition), asc(task.id))
        .all();
      const place = placementOf(tx, row.id);
      const dto = toTaskDto(
        row,
        place !== undefined && place.userId === actor.userId ? place : null,
        { description: true, trash: true },
        loadTaskExtras(tx, [row.id]),
      );
      return {
        ...dto,
        description: row.description,
        subtasks: taskDtos(tx, actor.userId, subtasks),
        parentChain: ancestorsOf(tx, row)
          .reverse()
          .map((a) => ({ id: a.id, title: a.title })),
      };
    });
  }

  // --- reads --------------------------------------------------------------------------------

  /**
   * The actor's list in an org (06 §2.3): live groups (Inbox first) and every live task
   * placed in them, open or completed since `completedSince` (default: 14 days ago). Then,
   * with `placement: null`: every live subtask (any depth, any assignee, open or completed)
   * of those tasks, and the live parent chain of the actor's orphan subtasks (breadcrumbs).
   */
  myList(actor: Actor, orgRef: string, completedSince?: number): MyList {
    return immediate(this.deps.db, (tx) => {
      const { org } = requireMembership(tx, actor.userId, orgRef);
      const now = this.now();
      const since = completedSince ?? now - COMPLETED_WINDOW_MS;
      const groups = listGroups(tx, actor.userId, org.id);
      const placed = tx
        .select({ task, place: placement })
        .from(placement)
        .innerJoin(task, eq(task.id, placement.taskId))
        .innerJoin(taskGroup, eq(taskGroup.id, placement.groupId))
        .where(
          and(
            eq(placement.userId, actor.userId),
            eq(placement.orgId, org.id),
            isNull(task.deletedAt),
            isNull(taskGroup.deletedAt),
            or(isNull(task.completedAt), gte(task.completedAt, since)),
          ),
        )
        .orderBy(asc(placement.groupId), asc(placement.position), asc(placement.taskId))
        .all();
      const included = new Set(placed.map((r) => r.task.id));
      const extraIds = descendantsOf(tx, [...included], { deletedAt: null }).filter(
        (id) => !included.has(id),
      );
      for (const id of extraIds) included.add(id);
      const extra = liveTasksById(tx, extraIds);
      for (const { task: t } of placed) {
        if (t.parentId === null) continue;
        for (const a of ancestorsOf(tx, t)) {
          if (included.has(a.id) || a.deletedAt !== null) continue;
          included.add(a.id);
          extra.push(a);
        }
      }
      extra.sort(
        (a, b) =>
          compareKeys(a.parentId ?? '', b.parentId ?? '') ||
          compareKeys(a.subtaskPosition ?? '', b.subtaskPosition ?? '') ||
          compareKeys(a.id, b.id),
      );
      const places = new Map<string, PlacementRow | null>(placed.map((r) => [r.task.id, r.place]));
      const rows = [...placed.map((r) => r.task), ...extra];
      const expandedTaskIds = tx
        .select({ id: taskExpansion.taskId })
        .from(taskExpansion)
        .innerJoin(task, eq(task.id, taskExpansion.taskId))
        .where(
          and(
            eq(taskExpansion.userId, actor.userId),
            eq(task.orgId, org.id),
            isNull(task.deletedAt),
          ),
        )
        .orderBy(asc(taskExpansion.taskId))
        .all()
        .map((r) => r.id);
      return {
        groups: groups.map(toGroupDto),
        tasks: taskDtos(tx, actor.userId, rows, { places }),
        expandedTaskIds,
        serverTime: now,
      };
    });
  }

  /** Trash (06 §2.4): deleted tasks of the org, newest deletion first, cursor paged. */
  trash(actor: Actor, orgRef: string, query: PageQuery): TrashPage {
    return immediate(this.deps.db, (tx) => {
      const { org } = requireMembership(tx, actor.userId, orgRef);
      const limit = query.limit ?? PAGE_LIMIT_DEFAULT;
      const after = decodeCursor(query.cursor, isTrashCursor);
      const parent = alias(task, 'parent');
      const rows = tx
        .select({ task })
        .from(task)
        .leftJoin(parent, eq(parent.id, task.parentId))
        .where(
          and(
            eq(task.orgId, org.id),
            isNotNull(task.deletedAt),
            // A subtask deleted together with its parent is listed under the parent.
            or(
              isNull(task.parentId),
              isNull(parent.deletedAt),
              sql`${parent.deletedAt} <> ${task.deletedAt}`,
            ),
            after === null
              ? undefined
              : or(
                  lt(task.deletedAt, after[0]),
                  and(eq(task.deletedAt, after[0]), lt(task.id, after[1])),
                ),
          ),
        )
        .orderBy(desc(task.deletedAt), desc(task.id))
        .limit(limit + 1)
        .all()
        .map((r) => r.task);
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: taskDtos(tx, actor.userId, page, { trash: true }),
        nextCursor:
          rows.length > limit && last !== undefined
            ? encodeCursor([last.deletedAt ?? 0, last.id])
            : null,
      };
    });
  }

  /**
   * The general task query (06 §2.3) for the CLI and MCP. `my` (and any `groupId`) lists my
   * list in order. The smart views use the shared core selector (`selectView`), so they hold
   * exactly the tasks, in the order, the web shows: dates in the actor's timezone, sections
   * flattened in display order. `q` narrows any view with the search grammar (terms through
   * the FTS index, filters through the shared matcher).
   */
  query(actor: Actor, orgRef: string, query: TaskQuery): TaskPage {
    return immediate(this.deps.db, (tx) => {
      const { org } = requireMembership(tx, actor.userId, orgRef);
      const view = query.view ?? 'my';
      const completed = query.completed ?? 'false';
      const limit = query.limit ?? PAGE_LIMIT_DEFAULT;
      const offset = decodeCursor(query.cursor, isOffsetCursor)?.o ?? 0;
      const viewerTz =
        tx.select({ timezone: user.timezone }).from(user).where(eq(user.id, actor.userId)).get()
          ?.timezone ?? 'UTC';
      const nowMs = this.now();
      const due = { today: todayIn(viewerTz, nowMs), nowMs, viewerTz };

      const groupFilter =
        query.groupId === undefined
          ? undefined
          : requireOwnGroup(tx, actor.userId, query.groupId, { orgId: org.id }).id;
      const groups = listGroups(tx, actor.userId, org.id);
      let rows: { task: TaskRow; place: PlacementRow | null }[];
      if (view === 'my' || groupFilter !== undefined) {
        rows = tx
          .select({ task, place: placement })
          .from(placement)
          .innerJoin(task, eq(task.id, placement.taskId))
          .innerJoin(taskGroup, eq(taskGroup.id, placement.groupId))
          .where(
            and(
              eq(placement.userId, actor.userId),
              eq(placement.orgId, org.id),
              isNull(task.deletedAt),
              isNull(taskGroup.deletedAt),
              groupFilter === undefined ? undefined : eq(placement.groupId, groupFilter),
            ),
          )
          .all();
        const order = new Map(groups.map((g, i) => [g.id, i]));
        rows.sort(
          (a, b) =>
            (order.get(a.place?.groupId ?? '') ?? 0) - (order.get(b.place?.groupId ?? '') ?? 0) ||
            compareKeys(a.place?.position ?? '', b.place?.position ?? '') ||
            compareKeys(a.task.id, b.task.id),
        );
        if (view !== 'my') rows = rows.filter((r) => inSmartView(r.task, view, due));
      } else {
        const mine = tx
          .select()
          .from(task)
          .where(
            and(eq(task.orgId, org.id), eq(task.assigneeId, actor.userId), isNull(task.deletedAt)),
          )
          .all();
        const places = placementsFor(
          tx,
          actor.userId,
          mine.map((t) => t.id),
        );
        const dtos = taskDtos(tx, actor.userId, mine, { places });
        const byId = new Map(mine.map((t) => [t.id, t]));
        const sections = selectView(
          {
            groups: Object.fromEntries(groups.map((g) => [g.id, toGroupDto(g)])),
            tasks: Object.fromEntries(dtos.map((d) => [d.id, d])),
          },
          view,
          { ...due, viewerId: actor.userId, showCompleted: completed !== 'false' },
        );
        const ids = [...new Set(sections.flatMap((s) => s.taskIds))];
        rows = ids.flatMap((id) => {
          const t = byId.get(id);
          return t === undefined ? [] : [{ task: t, place: places.get(id) ?? null }];
        });
      }

      const wantedTags = this.resolveTagFilter(tx, org.id, query.tag);
      const tagged =
        wantedTags === null
          ? null
          : this.tagSets(
              tx,
              rows.map((r) => r.task.id),
            );
      let filtered = rows.filter(({ task: t }) => {
        if (wantedTags !== null) {
          const has = tagged?.get(t.id);
          if (wantedTags.some((id) => id === null || has?.has(id) !== true)) return false;
        }
        const done = t.completedAt !== null;
        if (completed === 'false' && done) return false;
        if (completed === 'true' && !done) return false;
        if (query.dueFrom !== undefined && (t.dueDate === null || t.dueDate < query.dueFrom)) {
          return false;
        }
        if (query.dueTo !== undefined && (t.dueDate === null || t.dueDate > query.dueTo)) {
          return false;
        }
        return true;
      });
      if (query.q !== undefined) filtered = this.matchQuery(tx, actor, org.id, query.q, filtered);
      const page = filtered.slice(offset, offset + limit);
      return {
        items: taskDtos(
          tx,
          actor.userId,
          page.map((r) => r.task),
          { places: new Map(page.map((r) => [r.task.id, r.place])) },
        ),
        nextCursor: offset + limit < filtered.length ? encodeCursor({ o: offset + limit }) : null,
      };
    });
  }

  /** `?q=`: keeps the rows matching the search query (06 §2.3), in their order. */
  private matchQuery<R extends { task: TaskRow; place: PlacementRow | null }>(
    tx: Tx,
    actor: Actor,
    orgId: string,
    q: string,
    rows: R[],
  ): R[] {
    const matcher = this.search.matcher(tx, actor, [orgId], q);
    if (matcher === null) return [];
    const ids = this.search.matchingIds(tx, [orgId], matcher.fts);
    const hits = ids === null ? rows : rows.filter((r) => ids.has(r.task.id));
    if (!matcher.hasFilters) return hits;
    const dtos = taskDtos(
      tx,
      actor.userId,
      hits.map((r) => r.task),
      { places: new Map(hits.map((r) => [r.task.id, r.place])) },
    );
    return hits.filter((_, i) => matcher.accepts(dtos[i] as Task));
  }

  /**
   * `?tag=` values as tag IDs of the org: an ID of an org tag, else a name (case-insensitive).
   * An unknown value stays `null`, which matches no task. No filter: `null`.
   */
  private resolveTagFilter(
    tx: Tx,
    orgId: string,
    raw: string | string[] | undefined,
  ): (string | null)[] | null {
    if (raw === undefined) return null;
    const values = Array.isArray(raw) ? raw : [raw];
    const tags = tx.select().from(tagTable).where(eq(tagTable.orgId, orgId)).all();
    return values.map((v) => {
      const lower = v.toLowerCase();
      return (
        tags.find((t) => t.id === v)?.id ??
        tags.find((t) => t.name.toLowerCase() === lower)?.id ??
        null
      );
    });
  }

  private tagSets(tx: Tx, taskIds: readonly string[]): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const [id, tagIds] of loadTaskExtras(tx, taskIds).tagIds) out.set(id, new Set(tagIds));
    return out;
  }
}
