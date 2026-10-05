import {
  addDays,
  dueState,
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
  type Task,
  type TaskCompleteResult,
  type TaskCreate,
  type TaskMove,
  type TaskMoveResult,
  type TaskPage,
  type TaskPatch,
  type TaskPatchResult,
  type TaskQuery,
  type TrashPage,
} from '@rooster/core/schemas';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { organization, placement, task, taskGroup, user } from '../db/schema/index.ts';
import { AppError } from '../lib/errors.ts';
import { type Actor, immediate, type OpMeta, type ServiceDeps, type Tx } from './context.ts';
import { listGroups } from './group-service.ts';
import {
  clockAllows,
  descendantsOf,
  type GroupRow,
  inboxOf,
  parseClock,
  placementOf,
  placementsFor,
  posClockKey,
  requireOwnGroup,
  requireTask,
  softDeleteTasks,
  type TaskRow,
  taskDeleted,
  taskDtoFor,
  taskNotFound,
  toGroupDto,
  toTaskDto,
} from './list-access.ts';
import type { OrderTarget } from './ordering-service.ts';
import { requireMembership } from './org-access.ts';
import type { PlacementService } from './placement-service.ts';

const DAY_MS = 86_400_000;
/** my-list includes tasks completed within the last 14 days by default (06 §2.3). */
export const COMPLETED_WINDOW_MS = 14 * DAY_MS;

const DUE_KEYS = ['dueDate', 'dueTime', 'dueTz'] as const;

interface DueUnit {
  dueDate: string | null;
  dueTime: string | null;
  dueTz: string | null;
}

/**
 * The due unit as stored (05 §4.4): absent members are null, and a timezone is kept only
 * together with a time. An unknown timezone is a validation error, never a 5xx.
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
  return { dueDate, dueTime, dueTz };
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
const isOffsetCursor = (v: unknown): v is { o: number } =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as { o?: unknown }).o === 'number' &&
  Number.isInteger((v as { o: number }).o) &&
  (v as { o: number }).o >= 0;

/** Tasks (FR-TASK, 05 §4.3) and the actor's list reads. Authorisation is org membership. */
export class TaskService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly placements: PlacementService,
  ) {}

  private now(): number {
    return this.deps.clock();
  }

  // --- create -------------------------------------------------------------------------------

  /**
   * Creates a task assigned to the actor and places it in their list: in `groupId` (default
   * the Inbox) at the intent. Without any intent it goes to the top of the Inbox, or the end
   * of a named group. A repeated create with the same client `id` and content
   * returns the existing task; the same `id` with other content is `409 id_conflict`.
   */
  create(actor: Actor, orgRef: string, input: TaskCreate, _meta?: OpMeta): Task {
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
            existing.title === fields.title &&
            existing.description === description &&
            existing.dueDate === due.dueDate &&
            existing.dueTime === due.dueTime &&
            existing.dueTz === due.dueTz;
          if (!same) throw new AppError('id_conflict', 409, 'That ID is already in use.');
          return taskDtoFor(tx, actor.userId, existing);
        }
      }

      const group =
        fields.groupId === undefined
          ? inboxOf(tx, actor.userId, org.id)
          : requireOwnGroup(tx, actor.userId, fields.groupId, { orgId: org.id });
      const seq = tx
        .update(organization)
        .set({ taskSeq: sql`${organization.taskSeq} + 1` })
        .where(eq(organization.id, org.id))
        .returning({ taskSeq: organization.taskSeq })
        .get();
      const now = this.now();
      const row: TaskRow = {
        id: input.id ?? uuidv7(),
        orgId: org.id,
        seq: seq?.taskSeq ?? null,
        parentId: null,
        subtaskPosition: null,
        title: fields.title,
        description,
        assigneeId: actor.userId,
        createdBy: actor.userId,
        ...due,
        startDate: null,
        recurrence: null,
        recurrenceBasis: null,
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
      const intent: { afterId?: string | null; beforeId?: string | null } = {};
      if ('afterId' in input) intent.afterId = input.afterId ?? null;
      if ('beforeId' in input) intent.beforeId = input.beforeId ?? null;
      this.placements.reconcilePlacements(tx, [row.id], {
        userId: actor.userId,
        group,
        intent,
      });
      return taskDtoFor(tx, actor.userId, row);
    });
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
   * older than its clock. The due unit is one field (05 §4.4). Skipped fields are listed in
   * `ignoredFields`.
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
    if (applied) {
      const next = { ...changes, fieldClock: JSON.stringify(clock), updatedAt: this.now() };
      tx.update(task).set(next).where(eq(task.id, row.id)).run();
      Object.assign(row, next);
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
  }

  /**
   * Undoes a delete (or restores from Trash) with the descendants deleted together with it.
   * A placement whose group is gone moves to the top of its user's Inbox (05 §4.1).
   */
  restore(actor: Actor, taskId: string, meta: OpMeta): Task {
    return immediate(this.deps.db, (tx) => {
      const row = requireTask(tx, actor.userId, taskId);
      this.applyRestore(tx, row, meta);
      return taskDtoFor(tx, actor.userId, { ...row, ...this.reload(tx, row.id) });
    });
  }

  private reload(tx: Tx, taskId: string): TaskRow {
    const row = tx.select().from(task).where(eq(task.id, taskId)).get();
    if (row === undefined) throw taskNotFound();
    return row;
  }

  private applyRestore(tx: Tx, row: TaskRow, meta: OpMeta): void {
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
    tx.update(task)
      .set({ fieldClock: JSON.stringify(clock) })
      .where(eq(task.id, row.id))
      .run();
    const orphaned = tx
      .select({ taskId: placement.taskId, userId: placement.userId, orgId: placement.orgId })
      .from(placement)
      .innerJoin(taskGroup, eq(taskGroup.id, placement.groupId))
      .where(and(inArray(placement.taskId, ids), isNotNull(taskGroup.deletedAt)))
      .all();
    for (const p of orphaned) this.placements.rehomeToInbox(tx, p.userId, p.orgId, [p.taskId]);
  }

  /** Hard delete, only from Trash. Placements and subtasks go with it (FK cascade). */
  removePermanently(actor: Actor, taskId: string, _meta?: OpMeta): void {
    immediate(this.deps.db, (tx) => {
      const row = requireTask(tx, actor.userId, taskId);
      if (row.deletedAt === null) {
        throw new AppError('not_in_trash', 409, 'Only deleted tasks can be deleted permanently.');
      }
      tx.delete(task).where(eq(task.id, row.id)).run();
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
              this.applyRestore(tx, requireTask(tx, actor.userId, id), meta);
              break;
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

  // --- reads --------------------------------------------------------------------------------

  /**
   * The actor's list in an org (06 §2.3): live groups (Inbox first) and every live task
   * placed in them, open or completed since `completedSince` (default: 14 days ago).
   */
  myList(actor: Actor, orgRef: string, completedSince?: number): MyList {
    return immediate(this.deps.db, (tx) => {
      const { org } = requireMembership(tx, actor.userId, orgRef);
      const now = this.now();
      const since = completedSince ?? now - COMPLETED_WINDOW_MS;
      const groups = listGroups(tx, actor.userId, org.id);
      const rows = tx
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
      return {
        groups: groups.map(toGroupDto),
        tasks: rows.map((r) => toTaskDto(r.task, r.place)),
        expandedTaskIds: [],
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
      const places = placementsFor(
        tx,
        actor.userId,
        page.map((r) => r.id),
      );
      const last = page[page.length - 1];
      return {
        items: page.map((r) => toTaskDto(r, places.get(r.id) ?? null, { trash: true })),
        nextCursor:
          rows.length > limit && last !== undefined
            ? encodeCursor([last.deletedAt ?? 0, last.id])
            : null,
      };
    });
  }

  /**
   * The general task query (06 §2.3) for the CLI and MCP. Due-based views use the actor's
   * timezone (FR-VIEW-1). Results are ordered like the list for `my`/`groupId`, else by due
   * date, time and number.
   */
  query(actor: Actor, orgRef: string, query: TaskQuery): TaskPage {
    return immediate(this.deps.db, (tx) => {
      const { org } = requireMembership(tx, actor.userId, orgRef);
      const view = query.view ?? 'my';
      const completed = query.completed ?? 'false';
      const limit = query.limit ?? PAGE_LIMIT_DEFAULT;
      const offset = decodeCursor(query.cursor, isOffsetCursor)?.o ?? 0;
      const tz =
        tx.select({ timezone: user.timezone }).from(user).where(eq(user.id, actor.userId)).get()
          ?.timezone ?? 'UTC';
      const now = this.now();
      const today = todayIn(tz, now);

      const groupFilter =
        query.groupId === undefined
          ? undefined
          : requireOwnGroup(tx, actor.userId, query.groupId, { orgId: org.id }).id;
      const placed = view === 'my' || groupFilter !== undefined;
      let rows: { task: TaskRow; place: typeof placement.$inferSelect | null }[];
      if (placed) {
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
        const order = new Map(listGroups(tx, actor.userId, org.id).map((g, i) => [g.id, i]));
        rows.sort(
          (a, b) =>
            (order.get(a.place?.groupId ?? '') ?? 0) - (order.get(b.place?.groupId ?? '') ?? 0) ||
            compareKeys(a.place?.position ?? '', b.place?.position ?? '') ||
            compareKeys(a.task.id, b.task.id),
        );
      } else {
        const tasks = tx
          .select()
          .from(task)
          .where(
            and(eq(task.orgId, org.id), eq(task.assigneeId, actor.userId), isNull(task.deletedAt)),
          )
          .all();
        const places = placementsFor(
          tx,
          actor.userId,
          tasks.map((t) => t.id),
        );
        rows = tasks.map((t) => ({ task: t, place: places.get(t.id) ?? null }));
        rows.sort(
          (a, b) =>
            compareKeys(a.task.dueDate ?? '', b.task.dueDate ?? '') ||
            compareKeys(a.task.dueTime ?? '', b.task.dueTime ?? '') ||
            (a.task.seq ?? 0) - (b.task.seq ?? 0),
        );
      }

      const week = addDays(today, 6);
      const filtered = rows.filter(({ task: t }) => {
        const done = t.completedAt !== null;
        if (completed === 'false' && done) return false;
        if (completed === 'true' && !done) return false;
        if (query.dueFrom !== undefined && (t.dueDate === null || t.dueDate < query.dueFrom)) {
          return false;
        }
        if (query.dueTo !== undefined && (t.dueDate === null || t.dueDate > query.dueTo)) {
          return false;
        }
        switch (view) {
          case 'today':
            return t.dueDate !== null && t.dueDate <= today;
          case 'week':
            return t.dueDate !== null && t.dueDate >= today && t.dueDate <= week;
          case 'overdue':
            return (
              dueState(
                {
                  dueDate: t.dueDate,
                  dueTime: t.dueTime,
                  dueTz: t.dueTz,
                  completed: false,
                },
                { today, nowMs: now, viewerTz: tz },
              ) === 'overdue'
            );
          case 'nodate':
            return t.dueDate === null;
          default:
            return true;
        }
      });
      const page = filtered.slice(offset, offset + limit);
      return {
        items: page.map((r) => toTaskDto(r.task, r.place)),
        nextCursor: offset + limit < filtered.length ? encodeCursor({ o: offset + limit }) : null,
      };
    });
  }
}
