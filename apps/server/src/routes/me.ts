import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../lib/context.ts';
import type { Services } from '../services/index.ts';
import {
  ANY_CREDENTIAL,
  AUTHED,
  actorOf,
  body,
  idParam,
  json,
  orgIdParam,
  problems,
} from './common.ts';
import {
  MePatchSchema,
  MeSchema,
  OrgOrderResultSchema,
  OrgOrderSchema,
  OrgPrefPatchSchema,
  OrgSchema,
  SessionSchema,
} from './schemas.ts';

const tags = ['me'];

const getMe = createRoute({
  method: 'get',
  path: '/api/v1/me',
  tags,
  operationId: 'getMe',
  summary: 'The signed-in user, settings, orgs in sidebar order, and isAdmin',
  description:
    'The first call of every client: the profile, display settings (locale, timezone, week start, date and time format), `prefs`, every org I belong to with my role in sidebar order, whether I am an instance admin, and my attachment storage (`storage`: the bytes my uploads take and the quota, null without one). The CLI uses it to pick the default org.',
  responses: { 200: json(MeSchema, 'The signed-in user'), ...problems(401, ANY_CREDENTIAL) },
});

const patchMe = createRoute({
  method: 'patch',
  path: '/api/v1/me',
  tags,
  operationId: 'updateMe',
  summary: 'Update profile and settings (prefs are merged)',
  description:
    'Partial: send only the fields that change. `prefs` keys are merged into the stored prefs. `timezone` must be an IANA name the server knows. Answers the whole updated user.',
  request: { body: body(MePatchSchema) },
  responses: { 200: json(MeSchema, 'The updated user'), ...problems(...AUTHED) },
});

const listSessions = createRoute({
  method: 'get',
  path: '/api/v1/me/sessions',
  tags,
  operationId: 'listSessions',
  summary: 'Active sessions of the signed-in user',
  description:
    'Browser and device sessions that have not expired, most recently used first. `current` marks the session making this request.',
  responses: { 200: json(z.array(SessionSchema), 'Sessions, most recent first'), ...problems(401) },
});

const revokeSession = createRoute({
  method: 'delete',
  path: '/api/v1/me/sessions/{id}',
  tags,
  operationId: 'revokeSession',
  summary: 'Sign out a session; it is rejected on its next request',
  description:
    'Revokes one of my sessions (the current one included). Its open event streams close, and its next request is `401`. Another user’s session is `404`.',
  request: { params: z.object({ id: idParam('id', 'Session ID') }) },
  responses: { 204: { description: 'Revoked' }, ...problems(...AUTHED, 404) },
});

const putOrgOrder = createRoute({
  method: 'put',
  path: '/api/v1/me/org-order',
  tags,
  operationId: 'reorderOrg',
  summary: 'Move an org in the sidebar (server computes the position)',
  description:
    'An ordering intent among my orgs: `afterId` is the org directly above, `beforeId` the one directly below. The server computes the fractional key and returns it.',
  request: { body: body(OrgOrderSchema) },
  responses: { 200: json(OrgOrderResultSchema, 'The new position'), ...problems(...AUTHED, 404) },
});

const patchMyOrg = createRoute({
  method: 'patch',
  path: '/api/v1/me/orgs/{orgId}',
  tags,
  operationId: 'updateMyOrgPrefs',
  summary: 'Collapse or expand an org section in the sidebar',
  description: 'A per-member preference; other members are not affected.',
  request: { params: z.object({ orgId: orgIdParam }), body: body(OrgPrefPatchSchema) },
  responses: { 200: json(OrgSchema, 'The org with its prefs'), ...problems(...AUTHED, 404) },
});

export function registerMeRoutes(app: OpenAPIHono<AppEnv>, { users }: Services): void {
  app.openapi(getMe, (c) => c.json(users.getMe(actorOf(c)), 200));
  app.openapi(patchMe, (c) => c.json(users.updateMe(actorOf(c), c.req.valid('json')), 200));
  app.openapi(listSessions, (c) => c.json(users.listSessions(actorOf(c)), 200));
  app.openapi(revokeSession, (c) => {
    users.revokeSession(actorOf(c), c.req.valid('param').id);
    return c.body(null, 204);
  });
  app.openapi(putOrgOrder, (c) => c.json(users.reorderOrg(actorOf(c), c.req.valid('json')), 200));
  app.openapi(patchMyOrg, (c) => {
    const { orgId } = c.req.valid('param');
    return c.json(users.setOrgCollapsed(actorOf(c), orgId, c.req.valid('json').collapsed), 200);
  });
}
