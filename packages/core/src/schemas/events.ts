import { z } from 'zod';
import { idSchema, timestampSchema } from './common.ts';

/**
 * P4 Server-Sent Events contract (04 §4.5). `GET /api/v1/events` streams these as
 * `event: <type>` + `data: <json>`; `id:` is a monotonic server sequence.
 *
 * Invalidation keys are TanStack Query key prefixes the client invalidates verbatim:
 *   ['my-list', orgId] · ['task', taskId] · ['tags', orgId] · ['me'] · ['orgs']
 *   ['org-members', orgId] · ['org-invites', orgId] · ['trash', orgId]
 * Later phases add ['everyone', orgId], ['activity', taskId], ['notifications'].
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

export const SSE_EVENT_TYPES = ['hello', 'invalidate'] as const;
export const SSE_HEARTBEAT_MS = 25_000;

export type SseHello = z.infer<typeof sseHelloSchema>;
export type SseInvalidate = z.infer<typeof sseInvalidateSchema>;
