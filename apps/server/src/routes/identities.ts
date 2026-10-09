import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../lib/context.ts';
import { AUTHED, actorOf, idParam, json, problems } from './common.ts';
import type { P9RouteDeps } from './p9-deps.ts';
import { LinkedIdentitySchema } from './schemas-grants.ts';

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
    'Browser session only. The identity can no longer be used to sign in; signed-in browsers stay signed in. The last identity cannot be removed (`409 last_identity`).',
  request: { params: z.object({ id: idParam('id', 'Identity ID') }) },
  responses: { 204: { description: 'Unlinked' }, ...problems(...AUTHED, 404, 'last_identity') },
});

export function registerIdentityRoutes(app: OpenAPIHono<AppEnv>, { services }: P9RouteDeps): void {
  app.openAPIRegistry.register('LinkedIdentity', LinkedIdentitySchema);
  app.openapi(listIdentities, (c) => c.json(services.identities.list(actorOf(c)), 200));
  app.openapi(unlinkIdentity, (c) => {
    services.identities.unlink(actorOf(c), c.req.valid('param').id);
    return c.body(null, 204);
  });
}
