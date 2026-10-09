import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import {
  SSE_HEARTBEAT_MS,
  sseHelloSchema,
  sseInvalidateSchema,
  sseNotificationSchema,
} from '@rooster/core/schemas';
import { streamSSE } from 'hono/streaming';
import { SSE_MAX_PER_SESSION, SSE_MAX_PER_USER, type SseHub } from '../events/hub.ts';
import type { AppEnv } from '../lib/context.ts';
import { AppError } from '../lib/errors.ts';
import { named } from '../lib/openapi.ts';
import type { Services } from '../services/index.ts';
import { actorOf, problems } from './common.ts';

export const SseHelloSchema = named(sseHelloSchema, 'SseHello');
export const SseInvalidateSchema = named(sseInvalidateSchema, 'SseInvalidate');
export const SseNotificationSchema = named(sseNotificationSchema, 'SseNotification');

const STREAM_DESCRIPTION = [
  'A `text/event-stream` (04 §4.5). Every message has `event:`, `data:` (JSON) and a',
  'monotonic `id:` (per server process; there is no replay, so `Last-Event-ID` is ignored and',
  'clients refetch their active queries after a reconnect).',
  '',
  '- `hello` (first message): [`SseHello`](#/components/schemas/SseHello), the server version',
  '  for update detection and its clock.',
  '- `invalidate`: [`SseInvalidate`](#/components/schemas/SseInvalidate), query-key prefixes',
  '  to invalidate verbatim. Only the affected users receive it. `origin` is the',
  '  `X-Rooster-Client-Id` of the request that caused it, sent only to that user (null for',
  '  everyone else). Bursts within ~50 ms are coalesced.',
  '- `notification`: [`SseNotification`](#/components/schemas/SseNotification), only to the',
  '  recipient: the unread count, with a preview of a new notification (null when only the',
  '  count changed, e.g. after marking read on another device). Not coalesced.',
  `- \`: ping\` comment every ${SSE_HEARTBEAT_MS / 1000} s.`,
  '',
  'The stream ends on sign-out, session revoke, user deactivation and server shutdown. A',
  `session keeps at most ${SSE_MAX_PER_SESSION} streams and a user ${SSE_MAX_PER_USER}: opening one more`,
  'closes the oldest.',
].join('\n');

const eventsRoute = createRoute({
  method: 'get',
  path: '/api/v1/events',
  tags: ['events'],
  operationId: 'streamEvents',
  summary: 'Server-Sent Events: hello, invalidations, notifications and heartbeats',
  description: STREAM_DESCRIPTION,
  responses: {
    200: {
      description: 'The event stream',
      content: {
        'text/event-stream': {
          schema: z.string().openapi({
            example:
              'event: hello\nid: 1\ndata: {"version":"1.0.0","gitSha":"abc1234","serverTime":1767225600000}\n\n' +
              'event: invalidate\nid: 2\ndata: {"org":"0199…","keys":[["my-list","0199…"]],"origin":"tab-1"}\n\n',
          }),
        },
      },
    },
    ...problems(401, 429, 503),
  },
});

/** `GET /api/v1/events` (06 §2.9, WP 4.3). Auth is the usual actor middleware. */
export function registerEventRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: { hub: SseHub; services: Services },
): void {
  const { hub, services } = deps;
  app.openAPIRegistry.register('SseHello', SseHelloSchema);
  app.openAPIRegistry.register('SseInvalidate', SseInvalidateSchema);
  app.openAPIRegistry.register('SseNotification', SseNotificationSchema);

  app.openapi(eventsRoute, (c) => {
    const actor = actorOf(c);
    if (!hub.accepting) {
      throw new AppError('unavailable', 503, 'The server is shutting down; reconnect shortly.');
    }
    const response = streamSSE(
      c,
      (stream) =>
        new Promise<void>((resolve) => {
          const handle = hub.open({
            userId: actor.userId,
            sessionId: actor.sessionId,
            isValid: () => services.users.sessionActive(actor.userId, actor.sessionId),
            // `write` issues the underlying writer call synchronously, so frames keep their
            // order without a promise chain; `close` queues behind them.
            sink: {
              write: (text) => void stream.write(text),
              close: () => void stream.close(),
            },
            onClose: resolve,
          });
          if (handle === null) resolve();
          else stream.onAbort(() => handle.close());
        }),
    );
    // Proxies must neither buffer nor transform the stream (08 §5).
    response.headers.set('Cache-Control', 'no-cache, no-transform');
    response.headers.set('X-Accel-Buffering', 'no');
    return response;
  });
}
