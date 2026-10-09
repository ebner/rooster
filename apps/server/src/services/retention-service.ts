import { and, asc, eq, inArray, isNotNull, lt } from 'drizzle-orm';
import { comment, placement, task, taskGroup, verification } from '../db/schema/index.ts';
import { immediate, type ServiceDeps } from './context.ts';
import type { IdempotencyStore } from './idempotency-store.ts';
import type { NotificationService } from './notification-service.ts';
import type { PlacementService } from './placement-service.ts';
import { pruneIndex } from './search-index.ts';

/** Soft-deleted tasks and groups are kept for 30 days (05 §4.5). */
export const TRASH_RETENTION_MS = 30 * 86_400_000;

export interface PurgeReport {
  tasks: number;
  groups: number;
  comments: number;
  notifications: number;
  idempotency: number;
  verifications: number;
}

/**
 * The daily purge job (04 §4.6): Trash older than 30 days (tasks, groups and deleted
 * comments), read notifications older than 90 days, expired idempotency keys, and expired
 * better-auth `verification` rows (OAuth state and PKCE verifiers that abandoned sign-ins
 * leave behind).
 */
export class RetentionService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly placements: PlacementService,
    private readonly idempotency: IdempotencyStore,
    private readonly notifications: NotificationService,
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
      // Deleted comments are not in the search index, so nothing needs reindexing.
      const comments = tx
        .delete(comment)
        .where(and(isNotNull(comment.deletedAt), lt(comment.deletedAt, cutoff)))
        .run().changes;
      const notifications = this.notifications.purgeRead(tx, now);
      return { tasks, groups: groups.length, comments, notifications };
    });
    const verifications = this.deps.db.orm
      .delete(verification)
      .where(lt(verification.expiresAt, new Date(now)))
      .run().changes;
    return { ...report, idempotency: this.idempotency.purge(now), verifications };
  }
}
