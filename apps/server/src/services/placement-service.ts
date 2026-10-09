import type { OrderingIntent } from '@rooster/core/schemas';
import { and, eq, inArray } from 'drizzle-orm';
import { placement, task } from '../db/schema/index.ts';
import type { ServiceDeps, Tx } from './context.ts';
import { chunked, type GroupRow, inboxOf, placementDomain } from './list-access.ts';
import type { OrderingService, OrderTarget } from './ordering-service.ts';
import type { MemberRemovalStep } from './org-service.ts';

/**
 * Exception 1 of 05 §4.1: when the actor is the assignee and chose where the task goes
 * (create with a group or position), that wins over "top of the Inbox".
 */
export interface PlacementTarget {
  userId: string;
  group: GroupRow;
  /** Absent: the top of the Inbox (FR-GRP-5), or the end of any other group. */
  intent?: OrderingIntent;
}

/** Owns the placement invariant (05 §4.1) and the placement moves between groups. */
export class PlacementService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly ordering: OrderingService,
  ) {}

  /**
   * Places `taskIds` consecutively at `target` in the user's group (they must not be in the
   * group's domain yet, or are excluded from it). Returns the keys in the given order.
   */
  placeInGroup(
    tx: Tx,
    input: { userId: string; group: GroupRow; taskIds: readonly string[]; target: OrderTarget },
  ): string[] {
    const { userId, group, taskIds } = input;
    const now = this.deps.clock();
    const domain = placementDomain(
      tx,
      { userId, orgId: group.orgId, groupId: group.id, now },
      taskIds,
    );
    const { keys } = this.ordering.place(domain, input.target, taskIds.length);
    taskIds.forEach((taskId, i) => {
      const values = {
        taskId,
        userId,
        orgId: group.orgId,
        groupId: group.id,
        position: keys[i] as string,
        updatedAt: now,
      };
      tx.insert(placement)
        .values(values)
        .onConflictDoUpdate({ target: placement.taskId, set: values })
        .run();
    });
    return keys;
  }

  /** Re-homes placements at the top of their user's Inbox (restore into a gone group, purge). */
  rehomeToInbox(tx: Tx, userId: string, orgId: string, taskIds: readonly string[]): void {
    if (taskIds.length === 0) return;
    this.placeInGroup(tx, { userId, group: inboxOf(tx, userId, orgId), taskIds, target: 'top' });
  }

  /**
   * Enforces the placement invariant (05 §4.1) for the tasks and their direct children.
   * Runs in every transaction that changes a task's assignee or parent. Deletion does not
   * call it: a soft-deleted task keeps its placement.
   */
  reconcilePlacements(tx: Tx, taskIds: readonly string[], target?: PlacementTarget): void {
    if (taskIds.length === 0) return;
    // Batched pre-check: most tasks (a big subtree's children) are already right, and only
    // the rest go through the per-task path. The tasks and their placements, then each
    // chunk's children joined with theirs: no IN list grows with the number of children.
    const rows = new Map<string, { assigneeId: string | null; parentId: string | null }>();
    const placedFor = new Map<string, string>();
    for (const chunk of chunked([...new Set(taskIds)])) {
      for (const r of tx
        .select({
          id: task.id,
          assigneeId: task.assigneeId,
          parentId: task.parentId,
          placedFor: placement.userId,
        })
        .from(task)
        .leftJoin(placement, eq(placement.taskId, task.id))
        .where(inArray(task.id, chunk))
        .all()) {
        rows.set(r.id, { assigneeId: r.assigneeId, parentId: r.parentId });
        if (r.placedFor !== null) placedFor.set(r.id, r.placedFor);
      }
      for (const r of tx
        .select({
          id: task.id,
          assigneeId: task.assigneeId,
          parentId: task.parentId,
          placedFor: placement.userId,
        })
        .from(task)
        .leftJoin(placement, eq(placement.taskId, task.id))
        .where(inArray(task.parentId, chunk))
        .all()) {
        rows.set(r.id, { assigneeId: r.assigneeId, parentId: r.parentId });
        if (r.placedFor !== null) placedFor.set(r.id, r.placedFor);
      }
    }
    const ids = [...rows.keys()];
    const missingParents = [
      ...new Set(
        [...rows.values()]
          .map((r) => r.parentId)
          .filter((p): p is string => p !== null && !rows.has(p)),
      ),
    ];
    const parentAssignee = new Map<string, string | null>(
      [...rows].map(([id, r]) => [id, r.assigneeId]),
    );
    for (const chunk of chunked(missingParents)) {
      for (const r of tx
        .select({ id: task.id, assigneeId: task.assigneeId })
        .from(task)
        .where(inArray(task.id, chunk))
        .all()) {
        parentAssignee.set(r.id, r.assigneeId);
      }
    }
    for (const id of ids) {
      const row = rows.get(id);
      if (row === undefined) continue;
      const needs =
        row.assigneeId !== null &&
        (row.parentId === null || parentAssignee.get(row.parentId) !== row.assigneeId);
      const existing = placedFor.get(id);
      if (!needs && existing === undefined) continue;
      if (needs && existing === row.assigneeId) continue;
      this.reconcileOne(tx, id, target);
    }
  }

  private reconcileOne(tx: Tx, taskId: string, target: PlacementTarget | undefined): void {
    const row = tx
      .select({
        orgId: task.orgId,
        assigneeId: task.assigneeId,
        parentId: task.parentId,
      })
      .from(task)
      .where(eq(task.id, taskId))
      .get();
    if (row === undefined) return;
    const parentAssignee =
      row.parentId === null
        ? undefined
        : tx
            .select({ assigneeId: task.assigneeId })
            .from(task)
            .where(eq(task.id, row.parentId))
            .get()?.assigneeId;
    const needs =
      row.assigneeId !== null && (row.parentId === null || parentAssignee !== row.assigneeId);
    const existing = tx
      .select({ userId: placement.userId })
      .from(placement)
      .where(eq(placement.taskId, taskId))
      .get();

    if (!needs || row.assigneeId === null) {
      if (existing !== undefined) tx.delete(placement).where(eq(placement.taskId, taskId)).run();
      return;
    }
    if (existing !== undefined && existing.userId === row.assigneeId) return;
    if (existing !== undefined) tx.delete(placement).where(eq(placement.taskId, taskId)).run();

    const assigneeId = row.assigneeId;
    if (target !== undefined && target.userId === assigneeId && target.group.orgId === row.orgId) {
      const { group, intent } = target;
      const fallback: OrderTarget = group.kind === 'inbox' ? 'top' : 'end';
      const explicit =
        intent !== undefined && ('afterId' in intent || 'beforeId' in intent) ? intent : null;
      this.placeInGroup(tx, {
        userId: assigneeId,
        group,
        taskIds: [taskId],
        target: explicit ?? fallback,
      });
      return;
    }
    this.rehomeToInbox(tx, assigneeId, row.orgId, [taskId]);
  }

  /**
   * Member removal (05 §4.2 steps 1–2), registered with OrgService: unassign every task of
   * the leaving member in the org (open, completed and soft-deleted), then reconcile, which
   * removes their placements before their groups are hard-deleted.
   */
  readonly memberRemovalStep: MemberRemovalStep = (tx, { orgId, userId }) => {
    const ids = tx
      .select({ id: task.id })
      .from(task)
      .where(and(eq(task.orgId, orgId), eq(task.assigneeId, userId)))
      .all()
      .map((r) => r.id);
    if (ids.length > 0) {
      tx.update(task)
        .set({ assigneeId: null, updatedAt: this.deps.clock() })
        .where(inArray(task.id, ids))
        .run();
      this.reconcilePlacements(tx, ids);
    }
    // Belt and braces: no placement may outlive the groups deleted next.
    tx.delete(placement)
      .where(and(eq(placement.orgId, orgId), eq(placement.userId, userId)))
      .run();
  };
}
