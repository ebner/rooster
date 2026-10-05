import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../lib/context.ts';
import type { Services } from '../services/index.ts';
import { AUTHED, actorOf, body, idParam, json, orgIdParam, problems } from './common.ts';
import {
  InviteCreatedSchema,
  InviteCreateSchema,
  InviteSchema,
  MemberPatchSchema,
  MemberSchema,
  OrgCreateSchema,
  OrgDeleteSchema,
  OrgPatchSchema,
  OrgSchema,
} from './schemas.ts';

const tags = ['orgs'];
const orgParams = z.object({ orgId: orgIdParam });
const memberParams = z.object({ orgId: orgIdParam, userId: idParam('userId', 'User ID') });
const inviteParams = z.object({ orgId: orgIdParam, id: idParam('id', 'Invite ID') });

const listOrgs = createRoute({
  method: 'get',
  path: '/api/v1/orgs',
  tags,
  operationId: 'listOrgs',
  summary: 'Orgs of the signed-in user, in sidebar order',
  responses: { 200: json(z.array(OrgSchema), 'Orgs'), ...problems(401) },
});

const createOrg = createRoute({
  method: 'post',
  path: '/api/v1/orgs',
  tags,
  operationId: 'createOrg',
  summary: 'Create an org; the creator becomes its owner',
  request: { body: body(OrgCreateSchema) },
  responses: { 201: json(OrgSchema, 'The new org'), ...problems(...AUTHED, 409) },
});

const patchOrg = createRoute({
  method: 'patch',
  path: '/api/v1/orgs/{orgId}',
  tags,
  operationId: 'updateOrg',
  summary: 'Rename or restyle an org (owner). Personal org: avatarEmoji and color only',
  request: { params: orgParams, body: body(OrgPatchSchema) },
  responses: { 200: json(OrgSchema, 'The updated org'), ...problems(...AUTHED, 404, 409) },
});

const deleteOrg = createRoute({
  method: 'delete',
  path: '/api/v1/orgs/{orgId}',
  tags,
  operationId: 'deleteOrg',
  summary: 'Delete an org (owner, confirmName). Not the personal org',
  request: { params: orgParams, body: body(OrgDeleteSchema) },
  responses: { 204: { description: 'Deleted' }, ...problems(...AUTHED, 404, 409) },
});

const listMembers = createRoute({
  method: 'get',
  path: '/api/v1/orgs/{orgId}/members',
  tags,
  operationId: 'listMembers',
  summary: 'Members of an org',
  request: { params: orgParams },
  responses: { 200: json(z.array(MemberSchema), 'Members'), ...problems(401, 404) },
});

const patchMember = createRoute({
  method: 'patch',
  path: '/api/v1/orgs/{orgId}/members/{userId}',
  tags,
  operationId: 'updateMember',
  summary: "Change a member's role (owner). The last owner cannot be demoted",
  request: { params: memberParams, body: body(MemberPatchSchema) },
  responses: { 200: json(MemberSchema, 'The member'), ...problems(...AUTHED, 404, 409) },
});

const deleteMember = createRoute({
  method: 'delete',
  path: '/api/v1/orgs/{orgId}/members/{userId}',
  tags,
  operationId: 'removeMember',
  summary: 'Remove a member (owner) or leave (your own user ID)',
  request: { params: memberParams },
  responses: { 204: { description: 'Removed' }, ...problems(...AUTHED, 404, 409) },
});

const listInvites = createRoute({
  method: 'get',
  path: '/api/v1/orgs/{orgId}/invites',
  tags,
  operationId: 'listInvites',
  summary: 'Open invites of an org (owner)',
  request: { params: orgParams },
  responses: { 200: json(z.array(InviteSchema), 'Open invites'), ...problems(401, 403, 404) },
});

const createInvite = createRoute({
  method: 'post',
  path: '/api/v1/orgs/{orgId}/invites',
  tags,
  operationId: 'createInvite',
  summary: 'Invite by email (with `email`) or create an invite link (owner)',
  description:
    'Both kinds return a copyable `url` (`<ROOSTER_BASE_URL>/invite/<token>`). Email sending arrives in Phase 7. A personal org cannot be shared (`409 personal_org`).',
  request: { params: orgParams, body: body(InviteCreateSchema) },
  responses: { 201: json(InviteCreatedSchema, 'The invite'), ...problems(...AUTHED, 404, 409) },
});

const deleteInvite = createRoute({
  method: 'delete',
  path: '/api/v1/orgs/{orgId}/invites/{id}',
  tags,
  operationId: 'revokeInvite',
  summary: 'Revoke an invite of either kind (owner)',
  request: { params: inviteParams },
  responses: { 204: { description: 'Revoked' }, ...problems(...AUTHED, 404) },
});

export function registerOrgRoutes(app: OpenAPIHono<AppEnv>, { orgs }: Services): void {
  app.openapi(listOrgs, (c) => c.json(orgs.list(actorOf(c)), 200));
  app.openapi(createOrg, (c) => c.json(orgs.create(actorOf(c), c.req.valid('json')), 201));
  app.openapi(patchOrg, (c) =>
    c.json(orgs.update(actorOf(c), c.req.valid('param').orgId, c.req.valid('json')), 200),
  );
  app.openapi(deleteOrg, (c) => {
    orgs.remove(actorOf(c), c.req.valid('param').orgId, c.req.valid('json').confirmName);
    return c.body(null, 204);
  });
  app.openapi(listMembers, (c) =>
    c.json(orgs.listMembers(actorOf(c), c.req.valid('param').orgId), 200),
  );
  app.openapi(patchMember, (c) => {
    const { orgId, userId } = c.req.valid('param');
    return c.json(orgs.setRole(actorOf(c), orgId, userId, c.req.valid('json').role), 200);
  });
  app.openapi(deleteMember, (c) => {
    const { orgId, userId } = c.req.valid('param');
    orgs.removeMember(actorOf(c), orgId, userId);
    return c.body(null, 204);
  });
  app.openapi(listInvites, (c) =>
    c.json(orgs.listInvites(actorOf(c), c.req.valid('param').orgId), 200),
  );
  app.openapi(createInvite, (c) =>
    c.json(orgs.createInvite(actorOf(c), c.req.valid('param').orgId, c.req.valid('json')), 201),
  );
  app.openapi(deleteInvite, (c) => {
    const { orgId, id } = c.req.valid('param');
    orgs.revokeInvite(actorOf(c), orgId, id);
    return c.body(null, 204);
  });
}
