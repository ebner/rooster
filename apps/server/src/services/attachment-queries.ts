import type { Attachment } from '@rooster/core/schemas';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { attachment } from '../db/schema/index.ts';
import type { Tx } from './context.ts';
import { chunked } from './list-access.ts';

// Read helpers for task DTOs (P10, FR-ATT): the TaskDTO's `counts.attachments` and the
// detail's `attachments`. They do not authorise; callers have already checked the task.

export type AttachmentRow = typeof attachment.$inferSelect;

export function toAttachmentDto(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    taskId: row.taskId,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    uploaderId: row.uploaderId,
    image:
      row.width !== null && row.height !== null
        ? { width: row.width, height: row.height, thumb: row.thumbKey !== null }
        : null,
    createdAt: row.createdAt,
  };
}

/** Live attachment counts of `taskIds` (absent = 0). */
export function attachmentCounts(tx: Tx, taskIds: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const ids of chunked([...new Set(taskIds)])) {
    for (const r of tx
      .select({ taskId: attachment.taskId, n: sql<number>`count(*)` })
      .from(attachment)
      .where(and(inArray(attachment.taskId, ids), isNull(attachment.deletedAt)))
      .groupBy(attachment.taskId)
      .all()) {
      out.set(r.taskId, r.n);
    }
  }
  return out;
}

/** A task's live attachments, oldest first. */
export function attachmentsForTask(tx: Tx, taskId: string): Attachment[] {
  return tx
    .select()
    .from(attachment)
    .where(and(eq(attachment.taskId, taskId), isNull(attachment.deletedAt)))
    .orderBy(asc(attachment.createdAt), asc(attachment.id))
    .all()
    .map(toAttachmentDto);
}

/**
 * The bytes of every attachment `userId` uploaded that still exists (ADR 0052 §6): rows on
 * tasks in Trash count until the purge deletes them, and so would a row with `deleted_at`
 * set, whose blob is only freed when the row goes. Thumbnails and avatars are not counted.
 */
export function userStorageUsed(tx: Tx, userId: string): number {
  const row = tx
    .select({ bytes: sql<number>`coalesce(sum(${attachment.size}), 0)` })
    .from(attachment)
    .where(eq(attachment.uploaderId, userId))
    .get();
  return row?.bytes ?? 0;
}

/** `GET /me`'s `storage`: the usage and the quota (null without one). */
export function userStorage(
  tx: Tx,
  userId: string,
  quotaBytes: number | null,
): { usedBytes: number; quotaBytes: number | null } {
  return { usedBytes: userStorageUsed(tx, userId), quotaBytes };
}
