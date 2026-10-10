import { uuidv7 } from '@rooster/core/ids';
import { REMINDER_LATE_MAX_MS, REMINDERS_MAX } from '@rooster/core/limits';
import { type ReminderOwner, type ReminderSpec, resolveFireAt } from '@rooster/core/reminders';
import { type Reminder, type ReminderCreate, resolvePrefs } from '@rooster/core/schemas';
import { and, asc, eq, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import { task, taskReminder, user } from '../db/schema/index.ts';
import type { QueryKey } from '../events/bus.ts';
import { AppError } from '../lib/errors.ts';
import { logSafeError } from '../lib/log-safe-error.ts';
import {
  type Actor,
  emitAfterCommit,
  immediate,
  readOnly,
  type ServiceDeps,
  type Tx,
} from './context.ts';
import { isSharedOrg, qk, selfAudience } from './event-audience.ts';
import { authorizeTaskRead, requireScope } from './grant-access.ts';
import { SEND_GRACE_MS } from './job-runs.ts';
import { chunked, isMember, requireTask, type TaskRow, taskDeleted } from './list-access.ts';
import type { NotificationService } from './notification-service.ts';
import type { MemberRemovalStep } from './org-service.ts';

export type ReminderRow = typeof taskReminder.$inferSelect;

/** An absolute reminder may be this far in the past (clock skew, a slow client). */
const PAST_TOLERANCE_MS = 60_000;
/** Due reminders claimed per transaction by the job. */
const FIRE_BATCH = 100;

const reminderNotFound = () => new AppError('not_found', 404, 'Reminder not found.');

export function toReminderDto(row: ReminderRow): Reminder {
  return {
    id: row.id,
    taskId: row.taskId,
    kind: row.kind,
    offsetMinutes: row.offsetMinutes,
    remindAt: row.remindAt,
    fireAt: row.fireAt,
    firedAt: row.firedAt,
    createdAt: row.createdAt,
  };
}

/** Pending first by when they fire, dormant ones last, then by creation. */
function byFireAt(a: ReminderRow, b: ReminderRow): number {
  if (a.fireAt !== b.fireAt) {
    if (a.fireAt === null) return 1;
    if (b.fireAt === null) return -1;
    return a.fireAt - b.fireAt;
  }
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** The reminder owner's resolution settings (FR-REM-2), or null for an unknown user. */
function ownerOf(tx: Tx, userId: string): (ReminderOwner & { disabled: boolean }) | null {
  const row = tx
    .select({ timezone: user.timezone, prefs: user.prefs, disabledAt: user.disabledAt })
    .from(user)
    .where(eq(user.id, userId))
    .get();
  if (row === undefined) return null;
  return {
    timezone: row.timezone,
    allDayReminderTime: resolvePrefs(parseJson(row.prefs)).allDayReminderTime,
    disabled: row.disabledAt !== null,
  };
}

function sameSpec(row: ReminderRow, spec: ReminderSpec): boolean {
  return 'offsetMinutes' in spec
    ? row.kind === 'relative' && row.offsetMinutes === spec.offsetMinutes
    : row.kind === 'absolute' && row.remindAt === spec.at;
}

function specOf(input: ReminderCreate): ReminderSpec {
  return 'offsetMinutes' in input ? { offsetMinutes: input.offsetMinutes } : { at: input.at };
}

/**
 * Task reminders (FR-REM, ADR 0049 §2). Personal: every method acts on one user's own
 * reminders, and only that user hears about changes (per-user invalidations). `fire_at` is
 * kept resolved in the same transaction as every change it depends on, and the
 * `task-reminders` job claims each due row before anything is sent.
 */
export class ReminderService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly notifications: NotificationService,
  ) {}

  private now(): number {
    return this.deps.clock();
  }

  // --- routes -------------------------------------------------------------------------------

  /** GET /tasks/:id/reminders: the actor's reminders on a task they can read, by `fireAt`. */
  list(actor: Actor, taskId: string): Reminder[] {
    return readOnly(this.deps.db, (tx) => {
      const row = requireTask(tx, actor.userId, taskId);
      authorizeTaskRead(tx, actor, row);
      return this.forViewer(tx, actor.userId, row.id);
    });
  }

  /**
   * POST /tasks/:id/reminders. The task must be readable (and, for grants, `tasks:write`;
   * group write constraints do not apply: nobody else sees a reminder). An identical
   * reminder, or a replay with the same client `id`, returns the existing one (`created:
   * false`, 200).
   */
  create(
    actor: Actor,
    taskId: string,
    input: ReminderCreate,
  ): { reminder: Reminder; created: boolean } {
    return immediate(this.deps.db, (tx) => {
      const row = this.requireWritable(tx, actor, taskId);
      if (row.deletedAt !== null) throw taskDeleted();
      const spec = specOf(input);
      if (input.id !== undefined) {
        const existing = tx.select().from(taskReminder).where(eq(taskReminder.id, input.id)).get();
        if (existing !== undefined) {
          if (
            existing.userId !== actor.userId ||
            existing.taskId !== row.id ||
            !sameSpec(existing, spec)
          ) {
            throw new AppError('id_conflict', 409, 'That ID is already in use.');
          }
          return { reminder: toReminderDto(existing), created: false };
        }
      }
      const result = this.add(tx, actor.userId, row, spec, input.id);
      if (result.created) this.announce(tx, actor.userId, row);
      return { reminder: toReminderDto(result.row), created: result.created };
    });
  }

  /** DELETE /tasks/:id/reminders/:reminderId: only the actor's own (others' are `404`). */
  remove(actor: Actor, taskId: string, reminderId: string): void {
    immediate(this.deps.db, (tx) => {
      const row = this.requireWritable(tx, actor, taskId);
      const changes = tx
        .delete(taskReminder)
        .where(
          and(
            eq(taskReminder.id, reminderId),
            eq(taskReminder.userId, actor.userId),
            eq(taskReminder.taskId, row.id),
          ),
        )
        .run().changes;
      if (changes === 0) throw reminderNotFound();
      this.announce(tx, actor.userId, row);
    });
  }

  private requireWritable(tx: Tx, actor: Actor, taskId: string): TaskRow {
    const row = requireTask(tx, actor.userId, taskId);
    authorizeTaskRead(tx, actor, row);
    requireScope(actor, 'tasks:write');
    return row;
  }

  // --- inside task writes -------------------------------------------------------------------

  /**
   * Adds one of the user's reminders to `row` (ADR 0049 §2.5): an identical one (same offset,
   * or same instant) is returned instead; `422 reminder_needs_due` for a relative reminder on
   * a task without a due date, `422 reminder_in_past` for an absolute one more than a minute
   * ago, `409 too_many_reminders` beyond REMINDERS_MAX (fired ones count until removed).
   */
  add(
    tx: Tx,
    userId: string,
    row: TaskRow,
    spec: ReminderSpec,
    id?: string,
  ): { row: ReminderRow; created: boolean } {
    const mine = this.rowsOf(tx, userId, row.id);
    const same = mine.find((r) => sameSpec(r, spec));
    if (same !== undefined) return { row: same, created: false };
    const now = this.now();
    if ('offsetMinutes' in spec && row.dueDate === null) {
      throw new AppError(
        'reminder_needs_due',
        422,
        'A reminder before the due date needs a due date.',
        [{ path: 'offsetMinutes', message: 'The task has no due date' }],
      );
    }
    if ('at' in spec && spec.at < now - PAST_TOLERANCE_MS) {
      throw new AppError('reminder_in_past', 422, 'The reminder time has already passed.', [
        { path: 'at', message: 'Choose a time in the future' },
      ]);
    }
    if (mine.length >= REMINDERS_MAX) {
      throw new AppError(
        'too_many_reminders',
        409,
        `A task can have at most ${REMINDERS_MAX} reminders.`,
      );
    }
    const owner = ownerOf(tx, userId);
    const kind = 'offsetMinutes' in spec ? 'relative' : 'absolute';
    const offsetMinutes = 'offsetMinutes' in spec ? spec.offsetMinutes : null;
    const remindAt = 'at' in spec ? spec.at : null;
    const created: ReminderRow = {
      id: id ?? uuidv7(),
      taskId: row.id,
      userId,
      kind,
      offsetMinutes,
      remindAt,
      fireAt: owner === null ? null : resolveFireAt({ kind, offsetMinutes, remindAt }, row, owner),
      firedAt: null,
      createdAt: now,
    };
    tx.insert(taskReminder).values(created).run();
    return { row: created, created: true };
  }

  /**
   * Task create/PATCH `reminders` and `clearReminders` (06 §2.4): not LWW fields, they act on
   * the actor's own reminders once the task write is applied. Announces the change to them.
   */
  applyTaskInput(
    tx: Tx,
    userId: string,
    row: TaskRow,
    input: { reminders?: readonly ReminderSpec[] | undefined; clearReminders?: true | undefined },
  ): void {
    let changed = false;
    if (input.clearReminders === true) {
      changed =
        tx
          .delete(taskReminder)
          .where(and(eq(taskReminder.userId, userId), eq(taskReminder.taskId, row.id)))
          .run().changes > 0;
    }
    for (const spec of input.reminders ?? []) {
      if (this.add(tx, userId, row, spec).created) changed = true;
    }
    if (changed) this.announce(tx, userId, row);
  }

  /** The user's reminders on the task, as the detail lists them (by `fireAt`). */
  forViewer(tx: Tx, userId: string, taskId: string): Reminder[] {
    return this.rowsOf(tx, userId, taskId).sort(byFireAt).map(toReminderDto);
  }

  private rowsOf(tx: Tx, userId: string, taskId: string): ReminderRow[] {
    return tx
      .select()
      .from(taskReminder)
      .where(and(eq(taskReminder.userId, userId), eq(taskReminder.taskId, taskId)))
      .all();
  }

  /**
   * Re-resolves every user's reminders on `row` after its due unit changed (ADR 0049 §2.1).
   * Pending ones move with the due moment, relative ones go dormant without a due date (and
   * come back with one). A relative reminder that already fired is re-armed when the due
   * moment moved it into the future, so postponing a task reminds again.
   */
  recomputeForTask(tx: Tx, row: TaskRow): void {
    const rows = tx.select().from(taskReminder).where(eq(taskReminder.taskId, row.id)).all();
    if (rows.length === 0) return;
    const owners = new Map<string, ReminderOwner | null>();
    const now = this.now();
    for (const r of rows) {
      if (r.kind === 'absolute') continue;
      if (!owners.has(r.userId)) owners.set(r.userId, ownerOf(tx, r.userId));
      const owner = owners.get(r.userId) ?? null;
      if (owner === null) continue;
      const fireAt = resolveFireAt(r, row, owner);
      if (fireAt === r.fireAt) continue;
      if (r.firedAt === null) {
        tx.update(taskReminder).set({ fireAt }).where(eq(taskReminder.id, r.id)).run();
      } else if (fireAt !== null && fireAt > now) {
        tx.update(taskReminder)
          .set({ fireAt, firedAt: null })
          .where(eq(taskReminder.id, r.id))
          .run();
      }
    }
  }

  /**
   * A recurring task's next instance (FR-REM-5): every user's relative reminders carry over,
   * pending again and resolved against the new due date; absolute ones stay behind.
   */
  copyRelative(tx: Tx, fromTaskId: string, next: TaskRow): void {
    const rows = tx
      .select()
      .from(taskReminder)
      .where(and(eq(taskReminder.taskId, fromTaskId), eq(taskReminder.kind, 'relative')))
      .orderBy(asc(taskReminder.createdAt), asc(taskReminder.id))
      .all();
    const now = this.now();
    const owners = new Map<string, ReminderOwner | null>();
    for (const r of rows) {
      if (!owners.has(r.userId)) owners.set(r.userId, ownerOf(tx, r.userId));
      const owner = owners.get(r.userId) ?? null;
      tx.insert(taskReminder)
        .values({
          id: uuidv7(),
          taskId: next.id,
          userId: r.userId,
          kind: 'relative',
          offsetMinutes: r.offsetMinutes,
          remindAt: null,
          fireAt: owner === null ? null : resolveFireAt(r, next, owner),
          firedAt: null,
          createdAt: now,
        })
        .run();
    }
    for (const userId of owners.keys()) this.announce(tx, userId, next);
  }

  /** A reminder change reaches only its owner (ADR 0049 §2.4): their views of the task. */
  private announce(tx: Tx, userId: string, row: Pick<TaskRow, 'id' | 'orgId'>): void {
    announceReminders(this.deps, tx, userId, row.orgId, [row.id]);
  }

  // --- the job ------------------------------------------------------------------------------

  /**
   * The per-minute `task-reminders` job (ADR 0049 §2.3), also run once at boot. Due rows are
   * taken oldest first in batches, and each is claimed (`fired_at` set) before anything is
   * sent, so it fires exactly once across restarts, overlapping runs and instances sharing
   * the database. A claimed row is dropped silently when its task is done or deleted, its
   * owner can no longer read it or is disabled, or it is more than a day late. Returns how
   * many reminders became notifications.
   */
  async runDue(): Promise<number> {
    const now = this.now();
    let sent = 0;
    for (;;) {
      const { taken, fired } = immediate(this.deps.db, (tx) => {
        const due = tx
          .select()
          .from(taskReminder)
          .where(
            and(
              isNotNull(taskReminder.fireAt),
              lte(taskReminder.fireAt, now),
              isNull(taskReminder.firedAt),
            ),
          )
          .orderBy(asc(taskReminder.fireAt), asc(taskReminder.id))
          .limit(FIRE_BATCH)
          .all();
        let fired = 0;
        for (const r of due) {
          const claimed = tx
            .update(taskReminder)
            .set({ firedAt: now })
            .where(and(eq(taskReminder.id, r.id), isNull(taskReminder.firedAt)))
            .run().changes;
          if (claimed !== 1) continue;
          try {
            if (this.fire(tx, r, now)) fired += 1;
          } catch (err) {
            // One broken row (an odd timezone) must not hold up everyone else's reminders.
            this.deps.logger.warn(
              { err: logSafeError(err), reminderId: r.id },
              'task reminder skipped',
            );
          }
        }
        return { taken: due.length, fired };
      });
      sent += fired;
      if (taken < FIRE_BATCH) break;
    }
    return sent;
  }

  /** A claimed reminder becomes a `reminder` notification, unless it is to be dropped. */
  private fire(tx: Tx, r: ReminderRow, now: number): boolean {
    const fireAt = r.fireAt ?? now;
    const t = tx.select().from(task).where(eq(task.id, r.taskId)).get();
    const owner = tx
      .select({ disabledAt: user.disabledAt })
      .from(user)
      .where(eq(user.id, r.userId))
      .get();
    // The bell goes either way.
    if (t !== undefined) this.announce(tx, r.userId, t);
    if (
      t === undefined ||
      t.completedAt !== null ||
      t.deletedAt !== null ||
      owner === undefined ||
      owner.disabledAt !== null ||
      !isMember(tx, r.userId, t.orgId) ||
      now - fireAt > REMINDER_LATE_MAX_MS
    ) {
      return false;
    }
    this.notifications.notify(tx, [
      {
        userId: r.userId,
        orgId: t.orgId,
        type: 'reminder',
        taskId: t.id,
        actorId: null,
        data: {
          reminderId: r.id,
          fireAt,
          late: now - fireAt > SEND_GRACE_MS,
          due:
            t.dueDate === null ? null : { dueDate: t.dueDate, dueTime: t.dueTime, dueTz: t.dueTz },
          // The inbox shows "due Fri 14:00" from the same snapshot (the DTO's `to`).
          ...(t.dueDate === null ? {} : { to: { dueDate: t.dueDate, dueTime: t.dueTime } }),
        },
      },
    ]);
    return true;
  }
}

function announceReminders(
  deps: ServiceDeps,
  tx: Tx,
  userId: string,
  orgId: string,
  taskIds: string[],
): void {
  const keys: QueryKey[] = [qk.myList(orgId), ...taskIds.map(qk.task)];
  if (isSharedOrg(tx, orgId)) keys.push(qk.everyone(orgId));
  emitAfterCommit(deps, tx, {
    type: 'task.updated',
    orgId,
    actorId: userId,
    subjects: taskIds,
    audiences: [selfAudience(userId, orgId, keys)],
  });
}

/**
 * Re-resolves the user's pending relative reminders after their timezone or
 * `allDayReminderTime` changed (ADR 0049 §2.1), in that transaction, and tells their streams.
 */
export function recomputeUserReminders(deps: ServiceDeps, tx: Tx, userId: string): void {
  const owner = ownerOf(tx, userId);
  if (owner === null) return;
  const rows = tx
    .select({ reminder: taskReminder, task })
    .from(taskReminder)
    .innerJoin(task, eq(task.id, taskReminder.taskId))
    .where(
      and(
        eq(taskReminder.userId, userId),
        eq(taskReminder.kind, 'relative'),
        isNull(taskReminder.firedAt),
      ),
    )
    .all();
  const changed = new Map<string, string[]>();
  for (const { reminder, task: t } of rows) {
    const fireAt = resolveFireAt(reminder, t, owner);
    if (fireAt === reminder.fireAt) continue;
    tx.update(taskReminder).set({ fireAt }).where(eq(taskReminder.id, reminder.id)).run();
    changed.set(t.orgId, [...(changed.get(t.orgId) ?? []), t.id]);
  }
  for (const [orgId, ids] of changed) announceReminders(deps, tx, userId, orgId, ids);
}

/** Member removal (ADR 0049 §2.4): the leaving member's reminders on that org's tasks go. */
export const reminderRemovalStep: MemberRemovalStep = (tx, { orgId, userId }) => {
  const ids = tx
    .select({ id: taskReminder.id })
    .from(taskReminder)
    .innerJoin(task, eq(task.id, taskReminder.taskId))
    .where(and(eq(taskReminder.userId, userId), eq(task.orgId, orgId)))
    .all()
    .map((r) => r.id);
  for (const chunk of chunked(ids)) {
    tx.delete(taskReminder).where(inArray(taskReminder.id, chunk)).run();
  }
};
