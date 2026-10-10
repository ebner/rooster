import { addDays, diffDays, todayIn } from '@rooster/core/dates';
import { uuidv7 } from '@rooster/core/ids';
import { nextInstance, normalizeRule, type RecurrenceBasis } from '@rooster/core/recurrence';
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { follower, task, taskGroup, taskTag, user } from '../db/schema/index.ts';
import { AppError } from '../lib/errors.ts';
import type { ActivityScope, ActivityService } from './activity-service.ts';
import type { ServiceDeps, Tx } from './context.ts';
import { insertTaskRow, placementOf, subtaskDomain, type TaskRow } from './list-access.ts';
import type { OrderingService } from './ordering-service.ts';
import type { PlacementService, PlacementTarget } from './placement-service.ts';
import type { ReminderService } from './reminder-service.ts';
import { attachTags } from './tag-service.ts';

/** The next instance of a series and every task created with it (for activity and events). */
export interface SeriesNext {
  next: TaskRow;
  /** The next instance and its copied subtasks. */
  created: string[];
}

const invalidRule = () =>
  new AppError('validation_failed', 422, 'The recurrence rule is not supported.', [
    { path: 'recurrence', message: 'Expected an RRULE subset such as FREQ=WEEKLY;BYDAY=MO' },
  ]);

/**
 * Recurring tasks (FR-REC, ADR 0049 §1): the rule as stored, and the next instance created in
 * the transaction that completes (or skips) one. A series has at most one open instance.
 */
export class RecurrenceService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly ordering: OrderingService,
    private readonly placements: PlacementService,
    private readonly activity: ActivityService,
    private readonly reminders: ReminderService,
  ) {}

  /** The rule as stored (ADR 0049 §1.1), anchored on `dueDate`; `422` when unsupported. */
  normalize(rule: string, dueDate: string, basis: RecurrenceBasis): string {
    const normalized = normalizeRule(rule, dueDate, basis);
    if (normalized === null) throw invalidRule();
    return normalized;
  }

  /**
   * The day a completion counts for (ADR 0049 §1.2): the edit time's date in the task's
   * `dueTz` for a timed task, otherwise in the completing user's timezone.
   */
  completionDate(tx: Tx, row: TaskRow, actorId: string, editTime: number): string {
    const tz =
      row.dueTime !== null && row.dueTz !== null
        ? row.dueTz
        : (tx.select({ timezone: user.timezone }).from(user).where(eq(user.id, actorId)).get()
            ?.timezone ?? 'UTC');
    return todayIn(tz, editTime);
  }

  /**
   * Continues the series of `row`, which was just completed (or skipped) on `completedOn`
   * (ADR 0049 §1.4): the next instance directly after it, with the same assignee, group and
   * parent, its copies and its subtasks. Null when the task does not repeat, the series ended
   * (COUNT, UNTIL), or another instance of the series is still open (§1.5). A `nextId` that
   * is already taken is `409 id_conflict`.
   */
  continueSeries(
    tx: Tx,
    scope: ActivityScope,
    row: TaskRow,
    completedOn: string,
    nextId?: string,
  ): SeriesNext | null {
    if (row.recurrence === null || row.dueDate === null) return null;
    const basis: RecurrenceBasis = row.recurrenceBasis ?? 'due';
    const seriesId = row.seriesId ?? row.id;
    if (row.seriesId === null) {
      tx.update(task).set({ seriesId }).where(eq(task.id, row.id)).run();
      row.seriesId = seriesId;
    }
    const open = tx
      .select({ id: task.id })
      .from(task)
      .where(
        and(
          eq(task.seriesId, seriesId),
          ne(task.id, row.id),
          isNull(task.deletedAt),
          isNull(task.completedAt),
        ),
      )
      .get();
    if (open !== undefined) return null;
    const dates = nextInstance(
      row.recurrence,
      basis,
      { dueDate: row.dueDate, startDate: row.startDate },
      completedOn,
    );
    if (dates === null) return null;
    if (nextId !== undefined) {
      const taken = tx.select({ id: task.id }).from(task).where(eq(task.id, nextId)).get();
      if (taken !== undefined) throw new AppError('id_conflict', 409, 'That ID is already in use.');
    }
    const now = this.deps.clock();
    const shift = diffDays(dates.dueDate, row.dueDate);
    const next = insertTaskRow(tx, {
      id: nextId ?? uuidv7(),
      orgId: row.orgId,
      parentId: row.parentId,
      subtaskPosition:
        row.parentId === null ? null : this.siblingAfter(tx, row.parentId, row.id, now),
      title: row.title,
      description: row.description,
      assigneeId: row.assigneeId,
      createdBy: row.createdBy,
      dueDate: dates.dueDate,
      dueTime: row.dueTime,
      dueTz: row.dueTz,
      startDate: dates.startDate,
      recurrence: dates.recurrence,
      recurrenceBasis: basis,
      seriesId,
      now,
    });
    this.copyTags(tx, row.id, next.id, now);
    this.copyFollowers(tx, row.id, next.id);
    // Placed before its subtasks exist, so only the instance itself takes the target.
    this.placements.reconcilePlacements(tx, [next.id], this.placeAfter(tx, row));
    this.activity.record(tx, next, scope, { type: 'created', data: {} });
    const created = [next.id, ...this.copySubtasks(tx, scope, row, next, shift, now)];
    this.reminders.copyRelative(tx, row.id, next);
    return { next, created };
  }

  /** Where the completed instance sits in its user's list: the next one goes right below. */
  private placeAfter(tx: Tx, row: TaskRow): PlacementTarget | undefined {
    const place = placementOf(tx, row.id);
    if (place === undefined) return undefined;
    const group = tx.select().from(taskGroup).where(eq(taskGroup.id, place.groupId)).get();
    if (group === undefined || group.deletedAt !== null) return undefined;
    return { userId: place.userId, group, intent: { afterId: row.id } };
  }

  private siblingAfter(tx: Tx, parentId: string, afterId: string, now: number): string {
    const domain = subtaskDomain(tx, { parentId, now });
    const [key] = this.ordering.place(domain, { afterId }).keys;
    return key as string;
  }

  private copyTags(tx: Tx, fromId: string, toId: string, now: number): void {
    const tagIds = tx
      .select({ tagId: taskTag.tagId })
      .from(taskTag)
      .where(eq(taskTag.taskId, fromId))
      .orderBy(asc(taskTag.addedAt), sql`${taskTag}.rowid`)
      .all()
      .map((t) => t.tagId);
    attachTags(tx, toId, tagIds, now);
  }

  /**
   * Followers carry over (FR-REC-3), muted rows included: someone who unfollowed one instance
   * is not followed again by the next.
   */
  private copyFollowers(tx: Tx, fromId: string, toId: string): void {
    const rows = tx
      .select({ userId: follower.userId, muted: follower.muted })
      .from(follower)
      .where(eq(follower.taskId, fromId))
      .orderBy(sql`${follower}.rowid`)
      .all();
    for (const r of rows) {
      tx.insert(follower)
        .values({ taskId: toId, userId: r.userId, muted: r.muted })
        .onConflictDoNothing()
        .run();
    }
  }

  /**
   * The live subtasks of `from`, copied recursively under `to` (ADR 0049 §1.4): open, in
   * order, with their tags, and with their dates shifted by the instance's shift. They have no
   * rule of their own. Returns the new ids.
   */
  private copySubtasks(
    tx: Tx,
    scope: ActivityScope,
    from: TaskRow,
    to: TaskRow,
    shift: number,
    now: number,
  ): string[] {
    const created: string[] = [];
    let frontier: [TaskRow, TaskRow][] = [[from, to]];
    const shifted = (date: string | null) => (date === null ? null : addDays(date, shift));
    while (frontier.length > 0) {
      const next: [TaskRow, TaskRow][] = [];
      for (const [source, target] of frontier) {
        const children = tx
          .select()
          .from(task)
          .where(and(eq(task.parentId, source.id), isNull(task.deletedAt)))
          .orderBy(asc(task.subtaskPosition), asc(task.id))
          .all();
        for (const child of children) {
          const copy = insertTaskRow(tx, {
            id: uuidv7(),
            orgId: child.orgId,
            parentId: target.id,
            // The new parent's domain is empty, so the original keys keep the order.
            subtaskPosition: child.subtaskPosition,
            title: child.title,
            description: child.description,
            assigneeId: child.assigneeId,
            createdBy: child.createdBy,
            dueDate: shifted(child.dueDate),
            dueTime: child.dueDate === null ? null : child.dueTime,
            dueTz: child.dueDate === null ? null : child.dueTz,
            startDate: child.dueDate === null ? null : shifted(child.startDate),
            now,
          });
          this.copyTags(tx, child.id, copy.id, now);
          this.activity.record(tx, copy, scope, { type: 'created', data: {} });
          created.push(copy.id);
          next.push([child, copy]);
        }
      }
      frontier = next;
    }
    if (created.length > 0) this.placements.reconcilePlacements(tx, created);
    return created;
  }
}
