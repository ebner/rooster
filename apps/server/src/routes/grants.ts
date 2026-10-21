import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../lib/context.ts';
import type { Services } from '../services/index.ts';
import { ANY_CREDENTIAL, AUTHED, actorOf, body, idParam, json, problems } from './common.ts';
import {
  DeviceApproveSchema,
  DeviceDenySchema,
  DeviceRequestSchema,
  GrantPatchSchema,
  GrantSchema,
  TokenCreatedSchema,
  TokenCreateSchema,
} from './schemas-grants.ts';

// Phase 8 agent access (06 §2.1, 11 §2–3): Settings → Connected apps, PATs and the device
// approval behind the `/device` page (Phase 12: for the OAuth device grant too, 11 §9).
// Authorisation is in GrantService.

const tags = ['me'];

const userCodeParam = z
  .string()
  .min(1)
  .max(64)
  .openapi({
    param: { name: 'userCode', in: 'path' },
    description: 'The code the device shows (`WDJB-MJHT`); case, dashes and spaces are ignored.',
    example: 'WDJBMJHT',
  });

const listGrants = createRoute({
  method: 'get',
  path: '/api/v1/me/grants',
  tags,
  operationId: 'listGrants',
  summary: 'Connected apps: every PAT, CLI device and app grant',
  description:
    'Unrevoked grants, newest first (expired ones too, until revoked). `current` marks the grant behind this request. Allowed for the browser session and for a CLI device or PAT (`rooster token ls`, `rooster apps ls`); an OAuth app sees only its own grant.',
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
    ...problems(...AUTHED, 404, 'widening_not_allowed', 'admin_only_scope'),
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
    'Answers the token (`rooster_pat_…`) once, with its grant; send it as `Authorization: Bearer rooster_pat_…`. `audience` is where it works: `api` (the default) at `/api/v1`, or `mcp` (an MCP token) at the remote MCP endpoint `/mcp` only, where `/api/v1` answers `401`; an MCP token never has `admin` (`422 admin_not_for_mcp`). The browser session may create any PAT. A CLI device session (`rooster token create`) may create one within its own grant: scopes it has, narrower constraints and an expiry no later than its own, else `422 widening_not_allowed`; the PAT outlives a revoke of the device. A PAT cannot create PATs (`403 forbidden_scope`). The `admin` capability needs an instance admin (`403 admin_only_scope`).',
  request: { body: body(TokenCreateSchema) },
  responses: {
    201: json(TokenCreatedSchema, 'The token and its grant'),
    ...problems(...AUTHED, 'widening_not_allowed', 'admin_only_scope', 'admin_not_for_mcp'),
  },
});

const getDevice = createRoute({
  method: 'get',
  path: '/api/v1/device/{userCode}',
  tags,
  operationId: 'getDeviceRequest',
  summary: 'What a device asks for, before approval',
  description:
    'Browser session only. The pending device request with this code (11 §9.3): the client (`firstParty` for `rooster-cli`; a third-party app is always unverified, named by its client id’s host, without a logo), the scopes it asked for (`rooster-cli`: all but `admin` when it named none, `admin` only for instance admins and never for `/mcp`; apps: never `admin`), the `resource` its tokens will work at (null for the legacy CLI flow), the request’s IP and time, the user’s live grant for the app (`existing`, for step-up) and whether "This session only" is offered. Unknown, expired, used and other users’ codes are all `404`; after 10 such misses within 10 minutes code entry is locked for the user (`429 rate_limited` with `Retry-After`). `decisionNonce` binds the approval or denial to this user and session.',
  request: { params: z.object({ userCode: userCodeParam }) },
  responses: {
    200: json(DeviceRequestSchema, 'The pending request'),
    ...problems(401, 404, 'rate_limited'),
  },
});

const approveDevice = createRoute({
  method: 'post',
  path: '/api/v1/device/{userCode}/approve',
  tags,
  operationId: 'approveDevice',
  summary: 'Approve a device with the chosen scopes and constraints',
  description:
    'Browser session only, with the `decisionNonce` that `GET /device/{userCode}` returned to this user and session (any other, e.g. after switching accounts, is `404`: load the request again). Scopes no wider than requested, else `422 widening_not_allowed`. `rooster-cli` gets a new device grant (`admin` is dropped unless the user is an instance admin); its next poll of `/api/auth/device/token` (legacy flow) receives a bearer session tied to it, or of `/api/auth/oauth2/token` (device grant) OAuth tokens for the requested resource. An app gets the user’s one grant for it, created or stepped up (the scopes it had stay, the approved ones are added, constraints and expiry as sent); `sessionOnly` ends it after a day without use and is offered to apps only (`422 session_only_not_offered`). Every approval through the device grant sends the user a `device_connected` notice. The default label is "rooster CLI on <device>" from the CLI’s User-Agent, or the app’s name.',
  request: { params: z.object({ userCode: userCodeParam }), body: body(DeviceApproveSchema) },
  responses: {
    200: json(GrantSchema, 'The new or updated grant'),
    ...problems(...AUTHED, 404, 'widening_not_allowed', 'session_only_not_offered'),
  },
});

const denyDevice = createRoute({
  method: 'post',
  path: '/api/v1/device/{userCode}/deny',
  tags,
  operationId: 'denyDevice',
  summary: 'Deny a device',
  description:
    'Browser session only, with the `decisionNonce` that `GET /device/{userCode}` returned to this user and session (any other is `404`). The device’s next poll gets `access_denied`.',
  request: { params: z.object({ userCode: userCodeParam }), body: body(DeviceDenySchema) },
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
    ['DeviceDeny', DeviceDenySchema],
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
  app.openapi(createToken, async (c) => {
    c.set('secretResponse', true);
    return c.json(await grants.createToken(actorOf(c), c.req.valid('json')), 201);
  });
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
    grants.denyDevice(actorOf(c), c.req.valid('param').userCode, c.req.valid('json'));
    return c.body(null, 204);
  });
}
