import { commentToPlainText, parseCommentMarkdown } from '@rooster/core/comment-markdown';
import { uuidv7 } from '@rooster/core/ids';
import { mentionedUserIds } from '@rooster/core/mentions';
import type { Comment, CommentCreate, CommentPatch } from '@rooster/core/schemas';
import { and, eq, inArray } from 'drizzle-orm';
import { comment, member } from '../db/schema/index.ts';
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
import { taskAudiences, taskReach } from './event-audience.ts';
import type { FollowerService } from './follower-service.ts';
import { authorizeTaskWrite, canReadTask } from './grant-access.ts';
import { requireTask, type TaskRow, taskDeleted } from './list-access.ts';
import {
  EXCERPT_MAX,
  type NotificationDraft,
  type NotificationService,
} from './notification-service.ts';
import { indexTasks } from './search-index.ts';

export type CommentRow = typeof comment.$inferSelect;

export function toCommentDto(row: CommentRow): Comment {
  return {
    id: row.id,
    taskId: row.taskId,
    authorId: row.authorId,
    body: row.body,
    createdAt: row.createdAt,
    editedAt: row.editedAt,
  };
}

const commentNotFound = () => new AppError('not_found', 404, 'Comment not found.');

/**
 * The plain-text excerpt of a comment for notifications (email, push, the inbox): the
 * Markdown-light rendered as text, as the web inbox shows it (mentions as `@Name`, links as
 * their label, no emphasis or code marks).
 */
export function commentExcerpt(body: string): string {
  const plain = commentToPlainText(parseCommentMarkdown(body)).replace(/\s+/g, ' ').trim();
  return plain.length <= EXCERPT_MAX ? plain : `${plain.slice(0, EXCERPT_MAX - 1)}…`;
}

/**
 * Comments (FR-COL-3, 06 §2.6). Any member of the task's org may comment; only the author
 * edits, deletes and restores (another member gets `403 forbidden`, a non-member `404`).
 * Every write reindexes the task's `comments` search column (ADR 0013).
 */
export class CommentService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly followers: FollowerService,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * Comments on a live task. The commenter and the mentioned members follow it; mentioned
   * members get `mention`, every other follower `comment`. Mentions of non-members are kept
   * in the body but ignored. A repeated `id` with the same task and body returns the comment.
   */
  create(actor: Actor, taskId: string, input: CommentCreate, _meta?: OpMeta): Comment {
    return immediate(this.deps.db, (tx) => {
      const target = requireTask(tx, actor.userId, taskId);
      authorizeTaskWrite(tx, actor, target, 'comments:write');
      if (input.id !== undefined) {
        const existing = tx.select().from(comment).where(eq(comment.id, input.id)).get();
        if (existing !== undefined) {
          const same =
            existing.taskId === target.id &&
            existing.authorId === actor.userId &&
            existing.body === input.body;
          if (!same) throw new AppError('id_conflict', 409, 'That ID is already in use.');
          return toCommentDto(existing);
        }
      }
      if (target.deletedAt !== null) throw taskDeleted();
      const row: CommentRow = {
        id: input.id ?? uuidv7(),
        taskId: target.id,
        authorId: actor.userId,
        body: input.body,
        createdAt: this.deps.clock(),
        editedAt: null,
        deletedAt: null,
      };
      tx.insert(comment).values(row).run();
      indexTasks(tx, [target.id]);
      const mentioned = this.mentionedMembers(tx, target.orgId, input.body);
      this.followers.autoFollow(tx, target, [actor.userId, ...mentioned]);
      const excerpt = commentExcerpt(input.body);
      const mentionSet = new Set(mentioned);
      const drafts: NotificationDraft[] = [
        ...mentioned.map((userId) => this.draft(target, actor, row, userId, 'mention', excerpt)),
        // A mentioned follower gets the mention only, never both for one comment.
        ...this.followers
          .activeFollowers(tx, target.id)
          .filter((userId) => !mentionSet.has(userId))
          .map((userId) => this.draft(target, actor, row, userId, 'comment', excerpt)),
      ];
      this.notifications.notify(tx, drafts);
      this.emit(tx, actor, 'comment.created', target);
      return toCommentDto(row);
    });
  }

  /**
   * Edits the body and sets `editedAt` (the "edited" label). Members newly mentioned by the
   * edit follow the task and get a `mention`; the other followers are not notified again.
   * An unchanged body is a no-op.
   */
  patch(actor: Actor, commentId: string, input: CommentPatch, _meta?: OpMeta): Comment {
    return immediate(this.deps.db, (tx) => {
      const { row, target } = this.requireOwn(tx, actor, commentId);
      if (row.deletedAt !== null) {
        throw new AppError('conflict_deleted', 410, 'The comment is deleted; restore it first.');
      }
      if (input.body === row.body) return toCommentDto(row);
      const editedAt = this.deps.clock();
      tx.update(comment).set({ body: input.body, editedAt }).where(eq(comment.id, row.id)).run();
      indexTasks(tx, [target.id]);
      const before = new Set(mentionedUserIds(row.body));
      const added = this.mentionedMembers(tx, target.orgId, input.body).filter(
        (u) => !before.has(u),
      );
      this.followers.autoFollow(tx, target, added);
      const excerpt = commentExcerpt(input.body);
      this.notifications.notify(
        tx,
        added.map((userId) => this.draft(target, actor, row, userId, 'mention', excerpt)),
      );
      this.emit(tx, actor, 'comment.updated', target);
      return toCommentDto({ ...row, body: input.body, editedAt });
    });
  }

  /** Soft delete (author only); deleting a deleted comment is a no-op. */
  remove(actor: Actor, commentId: string, _meta?: OpMeta): void {
    immediate(this.deps.db, (tx) => {
      const { row, target } = this.requireOwn(tx, actor, commentId);
      if (row.deletedAt !== null) return;
      tx.update(comment).set({ deletedAt: this.deps.clock() }).where(eq(comment.id, row.id)).run();
      indexTasks(tx, [target.id]);
      this.emit(tx, actor, 'comment.deleted', target);
    });
  }

  /**
   * Undoes a delete (author only) until the trash purge removes the comment (30 days).
   * Restoring a live comment returns it unchanged. Notifications are not sent again.
   */
  restore(actor: Actor, commentId: string, _meta?: OpMeta): Comment {
    return immediate(this.deps.db, (tx) => {
      const { row, target } = this.requireOwn(tx, actor, commentId);
      if (row.deletedAt === null) return toCommentDto(row);
      tx.update(comment).set({ deletedAt: null }).where(eq(comment.id, row.id)).run();
      indexTasks(tx, [target.id]);
      this.emit(tx, actor, 'comment.restored', target);
      return toCommentDto({ ...row, deletedAt: null });
    });
  }

  /**
   * A comment of a task the actor can see (else 404), written by the actor (else 403), on a
   * live task (else 410).
   */
  private requireOwn(
    tx: Tx,
    actor: Actor,
    commentId: string,
  ): { row: CommentRow; target: TaskRow } {
    const row = tx.select().from(comment).where(eq(comment.id, commentId)).get();
    if (row === undefined) throw commentNotFound();
    let target: TaskRow;
    try {
      target = requireTask(tx, actor.userId, row.taskId);
      if (!canReadTask(tx, actor, target)) throw commentNotFound();
    } catch (err) {
      if (err instanceof AppError && err.status === 404) throw commentNotFound();
      throw err;
    }
    authorizeTaskWrite(tx, actor, target, 'comments:write');
    if (row.authorId !== actor.userId) {
      throw new AppError('forbidden', 403, 'Only the author can change a comment.');
    }
    if (target.deletedAt !== null) throw taskDeleted();
    return { row, target };
  }

  /** The distinct mentioned users that are members of the org, in first-mention order. */
  private mentionedMembers(tx: Tx, orgId: string, body: string): string[] {
    const ids = mentionedUserIds(body);
    if (ids.length === 0) return [];
    const members = new Set(
      tx
        .select({ userId: member.userId })
        .from(member)
        .where(and(eq(member.organizationId, orgId), inArray(member.userId, ids)))
        .all()
        .map((r) => r.userId),
    );
    return ids.filter((id) => members.has(id));
  }

  private draft(
    target: TaskRow,
    actor: Actor,
    row: CommentRow,
    userId: string,
    type: 'comment' | 'mention',
    excerpt: string,
  ): NotificationDraft {
    return {
      userId,
      orgId: target.orgId,
      type,
      taskId: target.id,
      actorId: actor.userId,
      data: { commentId: row.id, excerpt },
    };
  }

  /**
   * The feed and the comment count changed: `['activity', id]`, `['task', id]` (and the
   * family) and `['everyone', org]` to every member, `['my-list', org]` to whoever lists it.
   */
  private emit(tx: Tx, actor: Actor, type: DomainEventType, target: TaskRow): void {
    emitAfterCommit(this.deps, tx, {
      type,
      orgId: target.orgId,
      actorId: actor.userId,
      subjects: [target.id],
      audiences: taskAudiences(tx, {
        orgId: target.orgId,
        actorId: actor.userId,
        reach: taskReach(tx, [target.id]),
        activity: [target.id],
      }),
    });
  }
}
