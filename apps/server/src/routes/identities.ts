import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../lib/context.ts';
import { AUTHED, actorOf, idParam, json, problems } from './common.ts';
import type { P9RouteDeps } from './p9-deps.ts';
import { LinkedIdentitySchema, RemovedIdentitySchema } from './schemas-grants.ts';

// P9 WP 9.6 (FR-SET-3, ADR 0041 §7): linked sign-in identities in Settings → Security.
// Authorisation is in IdentityService.

const tags = ['me'];

const listIdentities = createRoute({
  method: 'get',
  path: '/api/v1/me/identities',
  tags,
  operationId: 'listIdentities',
  summary: 'My linked sign-in identities',
  description:
    'Browser session only. Every identity provider account that signs in to this user, oldest first, with the provider’s display name and, when known, the email it vouched for.',
  responses: {
    200: json(z.array(LinkedIdentitySchema), 'Identities, oldest first'),
    ...problems(401),
  },
});

const unlinkIdentity = createRoute({
  method: 'delete',
  path: '/api/v1/me/identities/{id}',
  tags,
  operationId: 'unlinkIdentity',
  summary: 'Unlink a sign-in identity',
  description:
    'Browser session only. The identity is removed and blocked: signing in through it is refused, and it does not link again by email, until it is allowed again (`DELETE /api/v1/me/identities/removed/{id}`). Signed-in browsers stay signed in. The last identity cannot be removed (`409 last_identity`).',
  request: { params: z.object({ id: idParam('id', 'Identity ID') }) },
  responses: { 204: { description: 'Unlinked' }, ...problems(...AUTHED, 404, 'last_identity') },
});

const listRemovedIdentities = createRoute({
  method: 'get',
  path: '/api/v1/me/identities/removed',
  tags,
  operationId: 'listRemovedIdentities',
  summary: 'My removed sign-in identities',
  description:
    'Browser session only. Identities this user unlinked, newest first. Each stays blocked from signing in until it is allowed again.',
  responses: {
    200: json(z.array(RemovedIdentitySchema), 'Removed identities, newest first'),
    ...problems(401),
  },
});

const allowRemovedIdentity = createRoute({
  method: 'delete',
  path: '/api/v1/me/identities/removed/{id}',
  tags,
  operationId: 'allowRemovedIdentity',
  summary: 'Allow a removed sign-in identity again',
  description:
    'Browser session only. Lifts the block on a removed identity: the next sign-in through it links it to the account again (by email, as when it was first linked).',
  request: { params: z.object({ id: idParam('id', 'Removed identity ID') }) },
  responses: { 204: { description: 'Allowed again' }, ...problems(...AUTHED, 404) },
});

export function registerIdentityRoutes(app: OpenAPIHono<AppEnv>, { services }: P9RouteDeps): void {
  app.openAPIRegistry.register('LinkedIdentity', LinkedIdentitySchema);
  app.openAPIRegistry.register('RemovedIdentity', RemovedIdentitySchema);
  app.openapi(listIdentities, (c) => c.json(services.identities.list(actorOf(c)), 200));
  app.openapi(listRemovedIdentities, (c) =>
    c.json(services.identities.listRemoved(actorOf(c)), 200),
  );
  app.openapi(allowRemovedIdentity, (c) => {
    services.identities.allow(actorOf(c), c.req.valid('param').id);
    return c.body(null, 204);
  });
  app.openapi(unlinkIdentity, (c) => {
    services.identities.unlink(actorOf(c), c.req.valid('param').id);
    return c.body(null, 204);
  });
}
