import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../lib/context.ts';
import type { Services } from '../services/index.ts';
import { ANY_CREDENTIAL, AUTHED, actorOf, body, idParam, json, problems } from './common.ts';
import {
  PushSubscriptionCreateSchema,
  PushSubscriptionSchema,
  VapidPublicKeySchema,
} from './schemas.ts';

const subscriptionParams = z.object({ id: idParam('id', 'Push subscription ID') });

const getVapidKey = createRoute({
  method: 'get',
  path: '/api/v1/push/vapid-public-key',
  tags: ['push'],
  operationId: 'getVapidPublicKey',
  summary: 'The VAPID public key for `pushManager.subscribe({applicationServerKey})`',
  description:
    'Keys exist from the first boot on (generated unless set in the environment). After an admin regenerates them, existing subscriptions are gone and the browser must subscribe again with the new key.',
  responses: { 200: json(VapidPublicKeySchema, 'The key'), ...problems(401, ANY_CREDENTIAL) },
});

const listSubscriptions = createRoute({
  method: 'get',
  path: '/api/v1/me/push-subscriptions',
  tags: ['push'],
  operationId: 'listPushSubscriptions',
  summary: 'My subscribed devices, newest first, with their last successful push',
  description: 'For Settings → Notifications: each device can be tested or removed.',
  responses: {
    200: json(z.array(PushSubscriptionSchema), 'Devices'),
    ...problems(401),
  },
});

const createSubscription = createRoute({
  method: 'post',
  path: '/api/v1/me/push-subscriptions',
  tags: ['push'],
  operationId: 'createPushSubscription',
  summary: 'Subscribe this browser (upsert by endpoint)',
  description:
    'Send `PushSubscription.toJSON()` plus an optional device label. The endpoint must be https on a known Web Push service (FCM, Mozilla, Apple, WNS), otherwise `422`. Subscribing an endpoint that already exists updates its keys and moves it to the caller.',
  request: { body: body(PushSubscriptionCreateSchema) },
  responses: {
    201: json(PushSubscriptionSchema, 'The subscription'),
    ...problems(...AUTHED),
  },
});

const deleteSubscription = createRoute({
  method: 'delete',
  path: '/api/v1/me/push-subscriptions/{id}',
  tags: ['push'],
  operationId: 'deletePushSubscription',
  summary: 'Unsubscribe one of my devices',
  description: 'Another user’s subscription is `404`.',
  request: { params: subscriptionParams },
  responses: { 204: { description: 'Removed' }, ...problems(...AUTHED, 404) },
});

const testSubscription = createRoute({
  method: 'post',
  path: '/api/v1/me/push-subscriptions/{id}/test',
  tags: ['push'],
  operationId: 'testPushSubscription',
  summary: 'Send a test push to one of my devices and wait for the push service',
  description:
    '`204` once the push service accepted it. `410 push_gone`: the push service no longer knows the subscription, which is deleted (subscribe again). `502 push_failed`: any other refusal or timeout.',
  request: { params: subscriptionParams },
  responses: {
    204: { description: 'Sent' },
    ...problems(...AUTHED, 404, 'push_gone', 'push_failed'),
  },
});

const regenerateKeys = createRoute({
  method: 'post',
  path: '/api/v1/admin/push-keys/regenerate',
  tags: ['admin'],
  operationId: 'regeneratePushKeys',
  summary: 'Replace the VAPID keys and delete every push subscription (instance admins)',
  description:
    'Devices subscribe again with the new key when the app next opens. Keys set through `ROOSTER_VAPID_PUBLIC`/`_PRIVATE` cannot be replaced here (`409 push_keys_from_env`).',
  responses: {
    200: json(VapidPublicKeySchema, 'The new key'),
    ...problems(...AUTHED, 'forbidden', 'push_keys_from_env'),
  },
});

/** Web Push (06 §2.6, §2.10; FR-NOT-2). */
export function registerPushRoutes(app: OpenAPIHono<AppEnv>, { push }: Services): void {
  app.openapi(getVapidKey, (c) => {
    actorOf(c);
    return c.json(push.publicKey(), 200);
  });
  app.openapi(listSubscriptions, (c) => c.json(push.list(actorOf(c)), 200));
  app.openapi(createSubscription, (c) =>
    c.json(
      push.subscribe(actorOf(c), c.req.valid('json'), c.req.header('user-agent') ?? null),
      201,
    ),
  );
  app.openapi(deleteSubscription, (c) => {
    push.unsubscribe(actorOf(c), c.req.valid('param').id);
    return c.body(null, 204);
  });
  app.openapi(testSubscription, async (c) => {
    await push.test(actorOf(c), c.req.valid('param').id);
    return c.body(null, 204);
  });
  app.openapi(regenerateKeys, (c) => c.json(push.regenerate(actorOf(c)), 200));
}
