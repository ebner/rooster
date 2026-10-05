import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../lib/context.ts';
import type { Services } from '../services/index.ts';
import { AUTHED, actorOf, body, idParam, json, orgIdParam, problems } from './common.ts';
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
  responses: { 200: json(MeSchema, 'The signed-in user'), ...problems(401) },
});

const patchMe = createRoute({
  method: 'patch',
  path: '/api/v1/me',
  tags,
  operationId: 'updateMe',
  summary: 'Update profile and settings (prefs are merged)',
  request: { body: body(MePatchSchema) },
  responses: { 200: json(MeSchema, 'The updated user'), ...problems(...AUTHED) },
});

const listSessions = createRoute({
  method: 'get',
  path: '/api/v1/me/sessions',
  tags,
  operationId: 'listSessions',
  summary: 'Active sessions of the signed-in user',
  responses: { 200: json(z.array(SessionSchema), 'Sessions, most recent first'), ...problems(401) },
});

const revokeSession = createRoute({
  method: 'delete',
  path: '/api/v1/me/sessions/{id}',
  tags,
  operationId: 'revokeSession',
  summary: 'Sign out a session; it is rejected on its next request',
  request: { params: z.object({ id: idParam('id', 'Session ID') }) },
  responses: { 204: { description: 'Revoked' }, ...problems(...AUTHED, 404) },
});

const putOrgOrder = createRoute({
  method: 'put',
  path: '/api/v1/me/org-order',
  tags,
  operationId: 'reorderOrg',
  summary: 'Move an org in the sidebar (server computes the position)',
  request: { body: body(OrgOrderSchema) },
  responses: { 200: json(OrgOrderResultSchema, 'The new position'), ...problems(...AUTHED, 404) },
});

const patchMyOrg = createRoute({
  method: 'patch',
  path: '/api/v1/me/orgs/{orgId}',
  tags,
  operationId: 'updateMyOrgPrefs',
  summary: 'Collapse or expand an org section in the sidebar',
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
