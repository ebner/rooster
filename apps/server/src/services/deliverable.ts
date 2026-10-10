import type { NotificationType } from '@rooster/core/schemas';
import { and, eq, isNull } from 'drizzle-orm';
import { notification, organization } from '../db/schema/index.ts';
import type { DeliverableNotification } from '../mail/describe.ts';
import type { Tx } from './context.ts';
import { parseStoredData } from './notification-service.ts';
import { loadRecipient, type Recipient } from './pref-store.ts';

export type NotificationRow = typeof notification.$inferSelect;

export interface Deliverable {
  row: NotificationRow;
  recipient: Recipient;
  notification: DeliverableNotification;
}

export function toDeliverable(
  row: NotificationRow,
  org: { name: string; slug: string },
): DeliverableNotification {
  const stored = parseStoredData(row.data);
  return {
    id: row.id,
    type: row.type as NotificationType,
    orgName: org.name,
    orgSlug: org.slug,
    taskId: row.taskId,
    taskTitle: row.taskId === null ? null : (stored.taskTitle ?? ''),
    actorName: row.actorId === null ? null : (stored.actorName ?? ''),
    excerpt: stored.excerpt,
    dueTo: stored.to,
    ...(row.type === 'reminder'
      ? { reminder: { due: stored.due ?? null, late: stored.late === true } }
      : {}),
    createdAt: row.createdAt,
  };
}

/**
 * A notification still worth delivering: its org is live and its recipient enabled. Null
 * when it was deleted meanwhile (member removal, retention) or nobody can receive it.
 */
export function loadDeliverable(tx: Tx, id: string): Deliverable | null {
  const found = tx
    .select({ row: notification, name: organization.name, slug: organization.slug })
    .from(notification)
    .innerJoin(organization, eq(organization.id, notification.orgId))
    .where(and(eq(notification.id, id), isNull(organization.deletedAt)))
    .get();
  if (found === undefined) return null;
  const recipient = loadRecipient(tx, found.row.userId);
  if (recipient === null) return null;
  return { row: found.row, recipient, notification: toDeliverable(found.row, found) };
}
