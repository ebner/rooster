import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../lib/context.ts';
import type { Services } from '../services/index.ts';
import { ANY_CREDENTIAL, AUTHED, actorOf, body, idParam, json, problems } from './common.ts';
import {
  DeviceApproveSchema,
  DeviceRequestSchema,
  GrantPatchSchema,
  GrantSchema,
  TokenCreatedSchema,
  TokenCreateSchema,
} from './schemas-grants.ts';

// Phase 8 agent access (06 §2.1, 11 §2–3): Settings → Connected apps, PATs and the device
// approval behind the `/device` page. Authorisation is in GrantService.

const tags = ['me'];

const userCodeParam = z
  .string()
  .min(1)
  .max(64)
  .openapi({
    param: { name: 'userCode', in: 'path' },
    description: 'The code the CLI shows (`WDJB-MJHT`); case, dashes and spaces are ignored.',
    example: 'WDJBMJHT',
  });

const listGrants = createRoute({
  method: 'get',
  path: '/api/v1/me/grants',
  tags,
  operationId: 'listGrants',
  summary: 'Connected apps: every PAT, CLI device and app grant',
  description:
    'Unrevoked grants, newest first (expired ones too, until revoked). `current` marks the grant behind this request. Allowed for the browser session and for a CLI device or PAT (`rooster token ls`, `rooster apps ls`).',
  responses: {
    200: json(z.array(GrantSchema), 'Grants, newest first'),
    ...problems(401, ANY_CREDENTIAL),
  },
});

const patchGrant = createRoute({
  method: 'patch',
  path: '/api/v1/me/grants/{id}',
  tags,
  operationId: 'updateGrant',
  summary: 'Edit a grant’s label, scopes, constraints or expiry',
  description:
    'Browser session only. PATs and CLI devices change freely; an OAuth app’s access may only be narrowed (`422 widening_not_allowed`). Takes effect on the next request; the grant’s open event streams reconnect.',
  request: { params: z.object({ id: idParam('id', 'Grant ID') }), body: body(GrantPatchSchema) },
  responses: {
    200: json(GrantSchema, 'The updated grant'),
    ...problems(...AUTHED, 404, 'widening_not_allowed'),
  },
});

const revokeGrant = createRoute({
  method: 'delete',
  path: '/api/v1/me/grants/{id}',
  tags,
  operationId: 'revokeGrant',
  summary: 'Revoke a grant: its token or device session stops working',
  description:
    'The browser session may revoke any of my grants; a CLI device or PAT only its own (`rooster logout`). Deletes the PAT or the device session; the next request with it is `401`.',
  request: { params: z.object({ id: idParam('id', 'Grant ID') }) },
  responses: { 204: { description: 'Revoked' }, ...problems(...AUTHED, 404) },
});

const createToken = createRoute({
  method: 'post',
  path: '/api/v1/me/tokens',
  tags,
  operationId: 'createToken',
  summary: 'Create a personal access token (shown once)',
  description:
    'Answers the token (`rooster_pat_…`) once, with its grant; send it as `Authorization: Bearer rooster_pat_…`. The browser session may create any PAT. A CLI device session (`rooster token create`) may create one within its own grant: scopes it has, narrower constraints and an expiry no later than its own, else `422 widening_not_allowed`; the PAT outlives a revoke of the device. A PAT cannot create PATs (`403 forbidden_scope`).',
  request: { body: body(TokenCreateSchema) },
  responses: {
    201: json(TokenCreatedSchema, 'The token and its grant'),
    ...problems(...AUTHED, 'widening_not_allowed'),
  },
});

const getDevice = createRoute({
  method: 'get',
  path: '/api/v1/device/{userCode}',
  tags,
  operationId: 'getDeviceRequest',
  summary: 'What a CLI device asks for, before approval',
  description:
    'Browser session only. The pending device request with this code: the client and the scopes it asked for (`scope` of its `/api/auth/device/code` request; all scopes when it sent none). Unknown, expired or already handled codes are `404`.',
  request: { params: z.object({ userCode: userCodeParam }) },
  responses: { 200: json(DeviceRequestSchema, 'The pending request'), ...problems(401, 404) },
});

const approveDevice = createRoute({
  method: 'post',
  path: '/api/v1/device/{userCode}/approve',
  tags,
  operationId: 'approveDevice',
  summary: 'Approve a CLI device with the chosen scopes and constraints',
  description:
    'Browser session only. Creates the device grant (scopes no wider than requested, else `422 widening_not_allowed`); the CLI’s next poll of `/api/auth/device/token` receives a bearer session tied to it. The default label is "rooster CLI on <device>" from the CLI’s User-Agent.',
  request: { params: z.object({ userCode: userCodeParam }), body: body(DeviceApproveSchema) },
  responses: {
    200: json(GrantSchema, 'The new grant'),
    ...problems(...AUTHED, 404, 'widening_not_allowed'),
  },
});

const denyDevice = createRoute({
  method: 'post',
  path: '/api/v1/device/{userCode}/deny',
  tags,
  operationId: 'denyDevice',
  summary: 'Deny a CLI device',
  description: 'Browser session only. The CLI’s next poll gets `access_denied`.',
  request: { params: z.object({ userCode: userCodeParam }) },
  responses: { 204: { description: 'Denied' }, ...problems(...AUTHED, 404) },
});

export function registerGrantRoutes(app: OpenAPIHono<AppEnv>, { grants }: Services): void {
  for (const [name, schema] of [
    ['Grant', GrantSchema],
    ['GrantPatch', GrantPatchSchema],
    ['TokenCreate', TokenCreateSchema],
    ['TokenCreated', TokenCreatedSchema],
    ['DeviceRequest', DeviceRequestSchema],
    ['DeviceApprove', DeviceApproveSchema],
  ] as const) {
    app.openAPIRegistry.register(name, schema);
  }
  app.openapi(listGrants, (c) => c.json(grants.list(actorOf(c)), 200));
  app.openapi(patchGrant, (c) =>
    c.json(grants.patch(actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  app.openapi(revokeGrant, (c) => {
    grants.revoke(actorOf(c), c.req.valid('param').id);
    return c.body(null, 204);
  });
  app.openapi(createToken, async (c) =>
    c.json(await grants.createToken(actorOf(c), c.req.valid('json')), 201),
  );
  app.openapi(getDevice, (c) =>
    c.json(grants.deviceRequest(actorOf(c), c.req.valid('param').userCode), 200),
  );
  app.openapi(approveDevice, (c) =>
    c.json(
      grants.approveDevice(actorOf(c), c.req.valid('param').userCode, c.req.valid('json')),
      200,
    ),
  );
  app.openapi(denyDevice, (c) => {
    grants.denyDevice(actorOf(c), c.req.valid('param').userCode);
    return c.body(null, 204);
  });
}
