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
  InviteCreatedSchema,
  InviteCreateSchema,
  InviteSchema,
  MemberPatchSchema,
  MemberSchema,
  OrgCreateSchema,
  OrgDeleteSchema,
  OrgPatchSchema,
  OrgSchema,
  ResolvedMemberSchema,
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
  description:
    'The personal org first by default, then shared orgs, each with my role and sidebar state.',
  responses: { 200: json(z.array(OrgSchema), 'Orgs'), ...problems(401, ANY_CREDENTIAL) },
});

const createOrg = createRoute({
  method: 'post',
  path: '/api/v1/orgs',
  tags,
  operationId: 'createOrg',
  summary: 'Create an org; the creator becomes its owner',
  description:
    'Also creates my Inbox and the default groups in it. Without a `slug` one is derived from the name (`acme`, `acme-2`, …); a taken explicit slug is `409 slug_taken`.',
  request: { body: body(OrgCreateSchema) },
  responses: { 201: json(OrgSchema, 'The new org'), ...problems(...AUTHED, 'slug_taken') },
});

const patchOrg = createRoute({
  method: 'patch',
  path: '/api/v1/orgs/{orgId}',
  tags,
  operationId: 'updateOrg',
  summary: 'Rename or restyle an org (owner). Personal org: avatarEmoji and color only',
  description:
    'Owners only (`403 forbidden`). Changing the slug changes the org’s URLs. The personal org keeps its name and slug (`409 personal_org`).',
  request: { params: orgParams, body: body(OrgPatchSchema) },
  responses: {
    200: json(OrgSchema, 'The updated org'),
    ...problems(...AUTHED, 404, 'forbidden', 'slug_taken', 'personal_org'),
  },
});

const deleteOrg = createRoute({
  method: 'delete',
  path: '/api/v1/orgs/{orgId}',
  tags,
  operationId: 'deleteOrg',
  summary: 'Delete an org (owner, confirmName). Not the personal org',
  description:
    'Deletes the org with every task, group, tag and comment in it, for every member. `confirmName` must equal the org’s name (`422 confirm_name_mismatch`). Cannot be undone.',
  request: { params: orgParams, body: body(OrgDeleteSchema) },
  responses: {
    204: { description: 'Deleted' },
    ...problems(...AUTHED, 404, 'forbidden', 'personal_org', 'confirm_name_mismatch'),
  },
});

const listMembers = createRoute({
  method: 'get',
  path: '/api/v1/orgs/{orgId}/members',
  tags,
  operationId: 'listMembers',
  summary: 'Members of an org',
  description:
    'Every member with their role, for assignee pickers and mentions. `email` is there for the signed-in browser only: apps and tokens with a grant see names, never colleagues’ emails, and assign by email through `GET /orgs/{orgId}/members/resolve`.',
  request: { params: orgParams },
  responses: { 200: json(z.array(MemberSchema), 'Members'), ...problems(401, 404) },
});

const resolveMemberQuery = z.object({
  q: z.string().trim().min(1).max(254).openapi({
    description:
      '`me` (or `mig`), a member’s email address (any case), or a member’s full name (case and accents ignored).',
    example: 'bo@example.com',
  }),
});

const resolveMember = createRoute({
  method: 'get',
  path: '/api/v1/orgs/{orgId}/members/resolve',
  tags,
  operationId: 'resolveMember',
  summary: 'Find the member an email, a full name or "me" names',
  description:
    'For assigning by email or name without seeing anyone’s email (`--assign`, MCP’s `assignee`). `me` is the caller; an email matches exactly, ignoring case; a name matches the whole name. The answer never carries an email. No match is `404 not_found`, the same for an unknown email and an unknown name. A name several members share is `409 ambiguous_member`, listing them by name (at most 10).',
  request: { params: orgParams, query: resolveMemberQuery },
  responses: {
    200: json(ResolvedMemberSchema, 'The member'),
    ...problems(401, 404, 422, 'ambiguous_member'),
  },
});

const patchMember = createRoute({
  method: 'patch',
  path: '/api/v1/orgs/{orgId}/members/{userId}',
  tags,
  operationId: 'updateMember',
  summary: "Change a member's role (owner). The last owner cannot be demoted",
  description:
    'Owners only. Demoting the only owner is `409 last_owner`; a personal org has no other members (`409 personal_org`).',
  request: { params: memberParams, body: body(MemberPatchSchema) },
  responses: {
    200: json(MemberSchema, 'The member'),
    ...problems(...AUTHED, 404, 'forbidden', 'last_owner', 'personal_org'),
  },
});

const deleteMember = createRoute({
  method: 'delete',
  path: '/api/v1/orgs/{orgId}/members/{userId}',
  tags,
  operationId: 'removeMember',
  summary: 'Remove a member (owner) or leave (your own user ID)',
  description:
    'The member’s groups and placements in the org are deleted; tasks assigned to them become unassigned. The only owner cannot leave (`409 last_owner`).',
  request: { params: memberParams },
  responses: {
    204: { description: 'Removed' },
    ...problems(...AUTHED, 404, 'forbidden', 'last_owner', 'personal_org'),
  },
});

const listInvites = createRoute({
  method: 'get',
  path: '/api/v1/orgs/{orgId}/invites',
  tags,
  operationId: 'listInvites',
  summary: 'Open invites of an org (owner)',
  description:
    'Unexpired, unrevoked invites. Email invites carry their `url` again; link invite URLs are shown only when created.',
  request: { params: orgParams },
  responses: {
    200: json(z.array(InviteSchema), 'Open invites'),
    ...problems(401, 404, 'forbidden'),
  },
});

const createInvite = createRoute({
  method: 'post',
  path: '/api/v1/orgs/{orgId}/invites',
  tags,
  operationId: 'createInvite',
  summary: 'Invite by email (with `email`) or create an invite link (owner)',
  description:
    'Both kinds return a copyable `url` (`<ROOSTER_BASE_URL>/invite/<token>`), shown once for links. With SMTP configured an email invite is also sent (`emailed: true`). Email invites are single-use (`multiUse` is `422`). A personal org cannot be shared (`409 personal_org`); inviting a member is `409 already_member`.',
  request: { params: orgParams, body: body(InviteCreateSchema) },
  responses: {
    201: json(InviteCreatedSchema, 'The invite'),
    ...problems(...AUTHED, 404, 'forbidden', 'personal_org', 'already_member'),
  },
});

const deleteInvite = createRoute({
  method: 'delete',
  path: '/api/v1/orgs/{orgId}/invites/{id}',
  tags,
  operationId: 'revokeInvite',
  summary: 'Revoke an invite of either kind (owner)',
  description:
    'The invite URL stops working at once: its preview shows `valid: false` and claiming or accepting it is `410 invite_invalid`.',
  request: { params: inviteParams },
  responses: { 204: { description: 'Revoked' }, ...problems(...AUTHED, 404, 'forbidden') },
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
  app.openapi(resolveMember, (c) =>
    c.json(orgs.resolveMember(actorOf(c), c.req.valid('param').orgId, c.req.valid('query').q), 200),
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
