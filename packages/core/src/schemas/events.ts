import { z } from 'zod';
import { idSchema, timestampSchema } from './common.ts';

/**
 * P4 Server-Sent Events contract (04 §4.5). `GET /api/v1/events` streams these as
 * `event: <type>` + `data: <json>`; `id:` is a monotonic server sequence.
 *
 * Invalidation keys are TanStack Query key prefixes the client invalidates verbatim:
 *   ['my-list', orgId] · ['task', taskId] · ['tags', orgId] · ['me'] · ['orgs']
 *   ['org-members', orgId] · ['org-invites', orgId] · ['trash', orgId]
 * P6 adds ['everyone', orgId] (all org members), ['activity', taskId] (all org members) and
 * ['notifications'] (the recipient only).
 */
export const sseQueryKeySchema = z.array(z.string()).min(1).max(4);

export const sseHelloSchema = z.object({
  version: z.string(),
  gitSha: z.string(),
  serverTime: timestampSchema,
});

export const sseInvalidateSchema = z.object({
  /** The org the change happened in; null for user-level keys (e.g. ['me']). */
  org: idSchema.nullable(),
  keys: z.array(sseQueryKeySchema).min(1),
  /** `X-Rooster-Client-Id` of the request that caused it, so that tab can skip a refetch. */
  origin: z.string().nullable(),
});

/**
 * P6 `event: notification`, sent to the recipient after a notification is created or the
 * unread count changes (mark read/unread, from any tab or device). `notification` is the new
 * one (absent for a count-only update), for a live preview.
 */
export const sseNotificationSchema = z.object({
  unreadCount: z.int().nonnegative(),
  notification: z
    .object({
      id: idSchema,
      orgId: idSchema,
      type: z.string(),
      taskId: idSchema.nullable(),
      actorName: z.string().nullable(),
      title: z.string().nullable(),
    })
    .nullable(),
});

export const SSE_EVENT_TYPES = ['hello', 'invalidate', 'notification'] as const;
export const SSE_HEARTBEAT_MS = 25_000;

export type SseHello = z.infer<typeof sseHelloSchema>;
export type SseInvalidate = z.infer<typeof sseInvalidateSchema>;
export type SseNotification = z.infer<typeof sseNotificationSchema>;
