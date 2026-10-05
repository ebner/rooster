import { and, asc, eq, inArray, isNotNull, lt } from 'drizzle-orm';
import { placement, task, taskGroup } from '../db/schema/index.ts';
import { immediate, type ServiceDeps } from './context.ts';
import type { IdempotencyStore } from './idempotency-store.ts';
import type { PlacementService } from './placement-service.ts';
import { pruneIndex } from './search-index.ts';

/** Soft-deleted tasks and groups are kept for 30 days (05 §4.5). */
export const TRASH_RETENTION_MS = 30 * 86_400_000;

export interface PurgeReport {
  tasks: number;
  groups: number;
  idempotency: number;
}

/** The daily purge job (04 §4.6): Trash older than 30 days and expired idempotency keys. */
export class RetentionService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly placements: PlacementService,
    private readonly idempotency: IdempotencyStore,
  ) {}

  /**
   * Hard-deletes tasks and groups deleted before `now − 30 d`. Tasks go first (their
   * placements and subtasks cascade); placements that still reference a purged group are
   * re-homed to the top of their owner's Inbox, in their order, before the group goes
   * (05 §4.2). Idempotent: a second run finds nothing.
   */
  purge(now: number = this.deps.clock()): PurgeReport {
    const cutoff = now - TRASH_RETENTION_MS;
    const report = immediate(this.deps.db, (tx) => {
      const tasks = tx
        .delete(task)
        .where(and(isNotNull(task.deletedAt), lt(task.deletedAt, cutoff)))
        .run().changes;
      // Subtasks went with their parents (FK cascade); none of them was indexed, but a stray
      // row must never outlive its task.
      if (tasks > 0) pruneIndex(tx);
      const groups = tx
        .select({ id: taskGroup.id, userId: taskGroup.userId, orgId: taskGroup.orgId })
        .from(taskGroup)
        .where(and(isNotNull(taskGroup.deletedAt), lt(taskGroup.deletedAt, cutoff)))
        .all();
      for (const group of groups) {
        const stranded = tx
          .select({ taskId: placement.taskId })
          .from(placement)
          .where(eq(placement.groupId, group.id))
          .orderBy(asc(placement.position), asc(placement.taskId))
          .all()
          .map((p) => p.taskId);
        this.placements.rehomeToInbox(tx, group.userId, group.orgId, stranded);
      }
      if (groups.length > 0) {
        tx.delete(taskGroup)
          .where(
            inArray(
              taskGroup.id,
              groups.map((g) => g.id),
            ),
          )
          .run();
      }
      return { tasks, groups: groups.length };
    });
    return { ...report, idempotency: this.idempotency.purge(now) };
  }
}
