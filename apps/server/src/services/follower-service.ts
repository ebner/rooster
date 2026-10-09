import type { FollowState } from '@rooster/core/schemas';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { follower, task } from '../db/schema/index.ts';
import { AppError } from '../lib/errors.ts';
import { type Actor, emitAfterCommit, immediate, type ServiceDeps, type Tx } from './context.ts';
import { isSharedOrg, memberIds, qk } from './event-audience.ts';
import { requireTask, type TaskRow, taskDeleted } from './list-access.ts';
import type { MemberRemovalStep } from './org-service.ts';

/** Followers (FR-COL-4). They exist in shared orgs only; personal orgs have none. */
export class FollowerService {
  constructor(private readonly deps: ServiceDeps) {}

  /**
   * Auto-follow: the creator, the assignee, commenters and mentioned members. Non-members
   * are skipped, and a muted row (an explicit unfollow) is left alone.
   */
  autoFollow(
    tx: Tx,
    target: Pick<TaskRow, 'id' | 'orgId'>,
    userIds: readonly (string | null)[],
  ): void {
    const wanted = [...new Set(userIds.filter((u): u is string => u !== null))];
    if (wanted.length === 0 || !isSharedOrg(tx, target.orgId)) return;
    const members = new Set(memberIds(tx, target.orgId));
    for (const userId of wanted) {
      if (!members.has(userId)) continue;
      tx.insert(follower)
        .values({ taskId: target.id, userId, muted: false })
        .onConflictDoNothing()
        .run();
    }
  }

  /** The unmuted followers, in follow order (a re-follow keeps the original slot). */
  activeFollowers(tx: Tx, taskId: string): string[] {
    return tx
      .select({ userId: follower.userId })
      .from(follower)
      .where(and(eq(follower.taskId, taskId), eq(follower.muted, false)))
      .orderBy(sql`${follower}.rowid`)
      .all()
      .map((r) => r.userId);
  }

  /**
   * PUT/DELETE /tasks/:id/followers/me. Unfollowing keeps a muted row so later auto-follow
   * does not add the user back. `409 personal_org` in a personal org; `410` for a deleted task.
   */
  setFollowing(actor: Actor, taskId: string, on: boolean): FollowState {
    return immediate(this.deps.db, (tx) => {
      const row = requireTask(tx, actor.userId, taskId);
      if (row.deletedAt !== null) throw taskDeleted();
      if (!isSharedOrg(tx, row.orgId)) {
        throw new AppError('personal_org', 409, 'Personal organisations have no followers.');
      }
      const changed = tx
        .insert(follower)
        .values({ taskId: row.id, userId: actor.userId, muted: !on })
        .onConflictDoUpdate({
          target: [follower.taskId, follower.userId],
          set: { muted: !on },
          setWhere: sql`${follower.muted} = ${on ? 1 : 0}`,
        })
        .run().changes;
      if (changed > 0) {
        emitAfterCommit(this.deps, tx, {
          type: 'task.followed',
          orgId: row.orgId,
          actorId: actor.userId,
          subjects: [row.id],
          audiences: [
            { org: row.orgId, userIds: memberIds(tx, row.orgId), keys: [qk.task(row.id)] },
          ],
        });
      }
      return { followers: this.activeFollowers(tx, row.id) };
    });
  }

  /** Member removal (05 §4.2): the leaving member stops following the org's tasks. */
  readonly memberRemovalStep: MemberRemovalStep = (tx, { orgId, userId }) => {
    const ids = tx
      .select({ id: task.id })
      .from(follower)
      .innerJoin(task, eq(task.id, follower.taskId))
      .where(and(eq(follower.userId, userId), eq(task.orgId, orgId)))
      .all()
      .map((r) => r.id);
    for (let i = 0; i < ids.length; i += 500) {
      tx.delete(follower)
        .where(and(eq(follower.userId, userId), inArray(follower.taskId, ids.slice(i, i + 500))))
        .run();
    }
  };
}
