// AC-1.6, 10 §3.3: every route in the OpenAPI document × every kind of actor. A route
// without a row here fails the "covers every route" test.

import type { GrantScope } from '@rooster/core/grants';
import { uuidv7 } from '@rooster/core/ids';
import type { GrantConstraintsValue as GrantConstraints } from '@rooster/core/schemas';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app.ts';
import type { AppDb } from '../src/db/client.ts';
import {
  accessGrant,
  account,
  deviceCode,
  oauthAccessToken,
  oauthClient,
  session,
  user,
} from '../src/db/schema/index.ts';
import { randomToken } from '../src/lib/tokens.ts';
import { OAUTH_ACCESS_PREFIX } from '../src/services/grant-service.ts';
import type { Actor } from '../src/services/index.ts';
import { hashOAuthToken } from '../src/services/oauth-grants.ts';
import { subscriptionBody } from './delivery-fakes.ts';
import {
  addSession,
  asJar,
  CookieJar,
  createTestApp,
  createUserWithSession,
  TEST_ENV,
  tempDir,
} from './helpers.ts';

/**
 * Browser actors (cookies), then the owner's non-browser credentials (P8, 11 §7): a
 * `tasks:read` PAT; a PAT with every scope writing only in group A of the shared org; one
 * reaching only the owner's personal org; a CLI device session with every scope everywhere;
 * an expired and a revoked PAT; the owner's browser session token sent as a bearer; and (P9)
 * an OAuth access token for `/api/v1` with every scope everywhere, and one issued for `/mcp`
 * (wrong audience). The `admin` capability has its own matrix (admin-capability.test.ts).
 */
const ACTORS = [
  'anonymous',
  'disabled',
  'nonMember',
  'member',
  'owner',
  'admin',
  'readOnlyPat',
  'writeInGroupPat',
  'otherOrgPat',
  'device',
  'expiredPat',
  'revokedPat',
  'browserBearer',
  'oauthApp',
  'mcpAudienceToken',
] as const;
type ActorKind = (typeof ACTORS)[number];
type TokenActor = Exclude<
  ActorKind,
  'anonymous' | 'disabled' | 'nonMember' | 'member' | 'owner' | 'admin'
>;
type CookieActor = Exclude<ActorKind, 'anonymous' | TokenActor>;
const TOKEN_ACTORS: ReadonlySet<ActorKind> = new Set<TokenActor>([
  'readOnlyPat',
  'writeInGroupPat',
  'otherOrgPat',
  'device',
  'expiredPat',
  'revokedPat',
  'browserBearer',
  'oauthApp',
  'mcpAudienceToken',
]);

type Expected = number;

const ALL_SCOPES: GrantScope[] = [
  'tasks:read',
  'tasks:write',
  'comments:write',
  'tasks:assign',
  'groups:write',
  'tasks:delete',
  'notifications:read',
];

/**
 * The owner's credentials with a grant: read-only, write-in-group A, other org, device. Dead
 * credentials (expired, revoked, a browser token as bearer) are 401 on every non-public route.
 */
const grants = (
  readOnlyPat: Expected,
  writeInGroupPat: Expected,
  otherOrgPat: Expected,
  device: Expected,
  oauthApp: Expected = device,
): Pick<Record<ActorKind, Expected>, TokenActor> => ({
  readOnlyPat,
  writeInGroupPat,
  otherOrgPat,
  device,
  expiredPat: 401,
  revokedPat: 401,
  browserBearer: 401,
  oauthApp,
  // A token is accepted only by the resource it was issued for (11 §4.3).
  mcpAudienceToken: 401,
});

/** Settings, org administration, admin, export, tokens and push need the browser (11 §2.1). */
const SESSION_ONLY = grants(403, 403, 403, 403);

interface Fixture {
  app: App;
  db: AppDb;
  orgId: string;
  /** A second plain member, the target of member-management routes. */
  otherMemberId: string;
  inviteId: string;
  inviteToken: string;
  allowlistId: string;
  /** The owner's groups in the shared org: two normal ones and a deleted one. */
  groupId: string;
  otherGroupId: string;
  deletedGroupId: string;
  /** The owner's task in the shared org, and one in Trash. */
  taskId: string;
  trashedTaskId: string;
  /** A subtask of `taskId`, and two tags of the shared org. */
  subtaskId: string;
  tagId: string;
  otherTagId: string;
  /** The owner's comment on `taskId`, and a deleted one. */
  commentId: string;
  deletedCommentId: string;
  backupName: string;
  /** The owner's push subscription. */
  pushSubscriptionId: string;
  /** Another grant of the owner (the target of grant edits), and a pending device code. */
  spareGrantId: string;
  userCode: string;
  /** A signed authorization request of an app (the consent screen's input). */
  oauthQuery: string;
  /** One of the owner's two linked sign-in identities. */
  identityId: string;
  // P10 fixtures (tasks): reminders.
  /** The owner's weekly task in group A, and the owner's reminder on `taskId`. */
  recurringTaskId: string;
  reminderId: string;
  // P10 fixtures (files): attachments, avatars, calendar feeds.
  /** The owner's image attachment (with a thumbnail) on `taskId`. */
  attachmentId: string;
  /** The other member, who has uploaded an avatar; and the owner's calendar feed. */
  avatarUserId: string;
  icalFeedId: string;
  jars: Record<CookieActor, CookieJar>;
  sessions: Record<CookieActor, string>;
  /** Bearer credentials of the token actors. */
  tokens: Record<TokenActor, string>;
}

interface Row {
  /** Builds the concrete request for an actor. */
  request: (f: Fixture, actor: ActorKind) => { path: string; body?: unknown };
  expect: Record<ActorKind, Expected>;
  /** A non-JSON success body (file download): only the content type is checked. */
  binary?: string;
  /** A never-ending success body (SSE): the content type is checked, then it is cancelled. */
  stream?: string;
}

/** Public routes answer everyone alike. */
const everyone = (status: number): Record<ActorKind, Expected> => ({
  anonymous: status,
  disabled: status,
  nonMember: status,
  member: status,
  owner: status,
  admin: status,
  readOnlyPat: status,
  writeInGroupPat: status,
  otherOrgPat: status,
  device: status,
  expiredPat: status,
  revokedPat: status,
  browserBearer: status,
  oauthApp: status,
  mcpAudienceToken: status,
});

/** Any signed-in, enabled user. */
const signedIn = (status: number): Record<ActorKind, Expected> => ({
  ...everyone(status),
  anonymous: 401,
  disabled: 401,
  ...SESSION_ONLY,
});

/** Org-scoped: non-members (the admin included) get 404 (04 §4.3). */
const orgScoped = (member: number, owner: number): Record<ActorKind, Expected> => ({
  anonymous: 401,
  disabled: 401,
  nonMember: 404,
  admin: 404,
  member,
  owner,
  ...SESSION_ONLY,
});

/** Groups are personal: everyone but their owner gets 404, fellow members included. */
const owned = (status: number): Record<ActorKind, Expected> => ({
  ...orgScoped(404, status),
});

const adminOnly = (status: number): Record<ActorKind, Expected> => ({
  anonymous: 401,
  disabled: 401,
  nonMember: 403,
  member: 403,
  owner: 403,
  admin: status,
  ...SESSION_ONLY,
});

const ROWS: Record<string, Row> = {
  'GET /api/v1/meta': { request: () => ({ path: '/api/v1/meta' }), expect: everyone(200) },
  'GET /api/v1/invites/{token}': {
    request: (f) => ({ path: `/api/v1/invites/${f.inviteToken}` }),
    expect: everyone(200),
  },
  'POST /api/v1/invites/{token}/claim': {
    request: (f) => ({ path: `/api/v1/invites/${f.inviteToken}/claim` }),
    // Public, but it sets a cookie: a non-browser request (no Origin) fails the CSRF check.
    expect: {
      ...everyone(200),
      ...Object.fromEntries([...TOKEN_ACTORS].map((a) => [a, 403])),
    },
  },
  'POST /api/v1/invites/{token}/accept': {
    request: (f) => ({ path: `/api/v1/invites/${f.inviteToken}/accept` }),
    // Anyone signed in may join through a valid link; members are a no-op.
    expect: { ...signedIn(200), ...grants(403, 403, 403, 403) },
  },
  'GET /api/v1/me': {
    request: () => ({ path: '/api/v1/me' }),
    expect: { ...signedIn(200), ...grants(200, 200, 200, 200) },
  },
  // Anyone signed in may listen; what reaches them is targeted per user (events.test.ts).
  'GET /api/v1/events': {
    request: () => ({ path: '/api/v1/events' }),
    expect: { ...signedIn(200), ...grants(200, 200, 200, 200) },
    stream: 'text/event-stream',
  },
  'PATCH /api/v1/me': {
    request: () => ({ path: '/api/v1/me', body: { name: 'Renamed' } }),
    expect: { ...signedIn(200), ...grants(403, 403, 403, 403) },
  },
  'GET /api/v1/me/sessions': {
    request: () => ({ path: '/api/v1/me/sessions' }),
    expect: { ...signedIn(200), ...grants(403, 403, 403, 403) },
  },
  'DELETE /api/v1/me/sessions/{id}': {
    request: (f, actor) => ({
      path: `/api/v1/me/sessions/${actor === 'anonymous' || TOKEN_ACTORS.has(actor) ? f.sessions.owner : f.sessions[actor as CookieActor]}`,
    }),
    expect: { ...signedIn(204), ...grants(403, 403, 403, 403) },
  },
  'PUT /api/v1/me/org-order': {
    request: (f) => ({ path: '/api/v1/me/org-order', body: { orgId: f.orgId } }),
    expect: { ...orgScoped(200, 200), ...grants(403, 403, 403, 403) },
  },
  'PATCH /api/v1/me/orgs/{orgId}': {
    request: (f) => ({ path: `/api/v1/me/orgs/${f.orgId}`, body: { collapsed: true } }),
    expect: { ...orgScoped(200, 200), ...grants(403, 403, 403, 403) },
  },
  'GET /api/v1/orgs': {
    request: () => ({ path: '/api/v1/orgs' }),
    expect: { ...signedIn(200), ...grants(200, 200, 200, 200) },
  },
  'POST /api/v1/orgs': {
    request: () => ({ path: '/api/v1/orgs', body: { name: 'New org' } }),
    expect: { ...signedIn(201), ...grants(403, 403, 403, 403) },
  },
  'PATCH /api/v1/orgs/{orgId}': {
    request: (f) => ({ path: `/api/v1/orgs/${f.orgId}`, body: { name: 'Renamed' } }),
    expect: { ...orgScoped(403, 200), ...grants(403, 403, 403, 403) },
  },
  'DELETE /api/v1/orgs/{orgId}': {
    request: (f) => ({ path: `/api/v1/orgs/${f.orgId}`, body: { confirmName: 'Shared' } }),
    expect: { ...orgScoped(403, 204), ...grants(403, 403, 403, 403) },
  },
  'GET /api/v1/orgs/{orgId}/members': {
    request: (f) => ({ path: `/api/v1/orgs/${f.orgId}/members` }),
    expect: { ...orgScoped(200, 200), ...grants(200, 200, 404, 200) },
  },
  'PATCH /api/v1/orgs/{orgId}/members/{userId}': {
    request: (f) => ({
      path: `/api/v1/orgs/${f.orgId}/members/${f.otherMemberId}`,
      body: { role: 'owner' },
    }),
    expect: { ...orgScoped(403, 200), ...grants(403, 403, 403, 403) },
  },
  'DELETE /api/v1/orgs/{orgId}/members/{userId}': {
    request: (f) => ({ path: `/api/v1/orgs/${f.orgId}/members/${f.otherMemberId}` }),
    expect: { ...orgScoped(403, 204), ...grants(403, 403, 403, 403) },
  },
  'GET /api/v1/orgs/{orgId}/invites': {
    request: (f) => ({ path: `/api/v1/orgs/${f.orgId}/invites` }),
    expect: { ...orgScoped(403, 200), ...grants(403, 403, 403, 403) },
  },
  'POST /api/v1/orgs/{orgId}/invites': {
    request: (f) => ({ path: `/api/v1/orgs/${f.orgId}/invites`, body: { role: 'member' } }),
    expect: { ...orgScoped(403, 201), ...grants(403, 403, 403, 403) },
  },
  'DELETE /api/v1/orgs/{orgId}/invites/{id}': {
    request: (f) => ({ path: `/api/v1/orgs/${f.orgId}/invites/${f.inviteId}` }),
    expect: { ...orgScoped(403, 204), ...grants(403, 403, 403, 403) },
  },
  'GET /api/v1/admin/allowlist': {
    request: () => ({ path: '/api/v1/admin/allowlist' }),
    expect: { ...adminOnly(200), ...grants(403, 403, 403, 403) },
  },
  'POST /api/v1/admin/allowlist': {
    request: () => ({
      path: '/api/v1/admin/allowlist',
      body: { kind: 'domain', value: 'new.example' },
    }),
    expect: { ...adminOnly(201), ...grants(403, 403, 403, 403) },
  },
  'DELETE /api/v1/admin/allowlist/{id}': {
    request: (f) => ({ path: `/api/v1/admin/allowlist/${f.allowlistId}` }),
    expect: { ...adminOnly(204), ...grants(403, 403, 403, 403) },
  },
  'GET /api/v1/admin/users': {
    request: () => ({ path: '/api/v1/admin/users' }),
    expect: { ...adminOnly(200), ...grants(403, 403, 403, 403) },
  },
  'PATCH /api/v1/admin/users/{id}': {
    request: (f) => ({ path: `/api/v1/admin/users/${f.otherMemberId}`, body: { disabled: true } }),
    expect: { ...adminOnly(200), ...grants(403, 403, 403, 403) },
  },
  'GET /api/v1/admin/backups': {
    request: () => ({ path: '/api/v1/admin/backups' }),
    expect: { ...adminOnly(200), ...grants(403, 403, 403, 403) },
  },
  'POST /api/v1/admin/backups': {
    request: () => ({ path: '/api/v1/admin/backups' }),
    expect: { ...adminOnly(201), ...grants(403, 403, 403, 403) },
  },
  'GET /api/v1/admin/backups/{name}': {
    request: (f) => ({ path: `/api/v1/admin/backups/${f.backupName}` }),
    expect: { ...adminOnly(200), ...grants(403, 403, 403, 403) },
    binary: 'application/vnd.sqlite3',
  },
  // Phase 2: the list. Tasks are visible to every member of their org; groups and
  // placements only to their owner.
  'GET /api/v1/orgs/{orgId}/my-list': {
    request: (f) => ({ path: `/api/v1/orgs/${f.orgId}/my-list` }),
    expect: { ...orgScoped(200, 200), ...grants(200, 200, 404, 200) },
  },
  'POST /api/v1/orgs/{orgId}/groups': {
    request: (f) => ({ path: `/api/v1/orgs/${f.orgId}/groups`, body: { name: 'New' } }),
    expect: { ...orgScoped(201, 201), ...grants(403, 403, 404, 201) },
  },
  'PATCH /api/v1/groups/{id}': {
    request: (f) => ({ path: `/api/v1/groups/${f.groupId}`, body: { name: 'Renamed' } }),
    expect: { ...owned(200), ...grants(403, 403, 404, 200) },
  },
  'POST /api/v1/groups/{id}/move': {
    request: (f) => ({ path: `/api/v1/groups/${f.groupId}/move`, body: { afterId: null } }),
    expect: { ...owned(200), ...grants(403, 403, 404, 200) },
  },
  'DELETE /api/v1/groups/{id}': {
    request: (f) => ({
      path: `/api/v1/groups/${f.groupId}`,
      body: { moveTasksTo: f.otherGroupId },
    }),
    expect: { ...owned(204), ...grants(403, 403, 404, 204) },
  },
  'POST /api/v1/groups/{id}/restore': {
    request: (f) => ({ path: `/api/v1/groups/${f.deletedGroupId}/restore` }),
    expect: { ...owned(200), ...grants(403, 403, 404, 200) },
  },
  'GET /api/v1/orgs/{orgId}/tasks': {
    request: (f) => ({ path: `/api/v1/orgs/${f.orgId}/tasks?view=today` }),
    expect: { ...orgScoped(200, 200), ...grants(200, 200, 404, 200) },
  },
  'POST /api/v1/orgs/{orgId}/tasks': {
    request: (f) => ({ path: `/api/v1/orgs/${f.orgId}/tasks`, body: { title: 'New task' } }),
    expect: { ...orgScoped(201, 201), ...grants(403, 403, 404, 201) },
  },
  'PATCH /api/v1/tasks/{id}': {
    request: (f) => ({ path: `/api/v1/tasks/${f.taskId}`, body: { title: 'Renamed' } }),
    expect: { ...orgScoped(200, 200), ...grants(403, 200, 404, 200) },
  },
  'POST /api/v1/tasks/{id}/move': {
    request: (f) => ({ path: `/api/v1/tasks/${f.taskId}/move`, body: { groupId: f.otherGroupId } }),
    // Only the owner has the task in their list.
    expect: { ...orgScoped(404, 200), ...grants(403, 403, 404, 200) },
  },
  'POST /api/v1/tasks/{id}/complete': {
    request: (f) => ({ path: `/api/v1/tasks/${f.taskId}/complete`, body: { completed: true } }),
    expect: { ...orgScoped(200, 200), ...grants(403, 200, 404, 200) },
  },
  'DELETE /api/v1/tasks/{id}': {
    request: (f) => ({ path: `/api/v1/tasks/${f.taskId}` }),
    expect: { ...orgScoped(204, 204), ...grants(403, 204, 404, 204) },
  },
  'POST /api/v1/tasks/{id}/restore': {
    request: (f) => ({ path: `/api/v1/tasks/${f.trashedTaskId}/restore` }),
    expect: { ...orgScoped(200, 200), ...grants(403, 403, 404, 200) },
  },
  'DELETE /api/v1/tasks/{id}/permanent': {
    request: (f) => ({ path: `/api/v1/tasks/${f.trashedTaskId}/permanent` }),
    expect: { ...orgScoped(204, 204), ...grants(403, 403, 404, 204) },
  },
  'POST /api/v1/tasks/bulk': {
    request: (f) => ({ path: '/api/v1/tasks/bulk', body: { op: 'complete', ids: [f.taskId] } }),
    // Per-task results: outsiders get `{ok: false, code: 'not_found'}` for each ID.
    expect: { ...signedIn(200), ...grants(200, 200, 200, 200) },
  },
  'GET /api/v1/orgs/{orgId}/trash': {
    request: (f) => ({ path: `/api/v1/orgs/${f.orgId}/trash` }),
    expect: { ...orgScoped(200, 200), ...grants(200, 200, 404, 200) },
  },
  // Phase 3: detail, subtasks, expansion and tags. Everything is org-scoped; expansion is
  // per user, so every member may expand any task they can see.
  'GET /api/v1/tasks/{id}': {
    request: (f) => ({ path: `/api/v1/tasks/${f.taskId}` }),
    expect: { ...orgScoped(200, 200), ...grants(200, 200, 404, 200) },
  },
  'POST /api/v1/tasks/{id}/reorder': {
    request: (f) => ({ path: `/api/v1/tasks/${f.subtaskId}/reorder`, body: { afterId: null } }),
    expect: { ...orgScoped(200, 200), ...grants(403, 200, 404, 200) },
  },
  'POST /api/v1/tasks/{id}/duplicate': {
    request: (f) => ({ path: `/api/v1/tasks/${f.taskId}/duplicate`, body: {} }),
    expect: { ...orgScoped(201, 201), ...grants(403, 201, 404, 201) },
  },
  'PUT /api/v1/tasks/{id}/expanded': {
    request: (f) => ({ path: `/api/v1/tasks/${f.taskId}/expanded` }),
    expect: { ...orgScoped(204, 204), ...grants(204, 204, 404, 204) },
  },
  'DELETE /api/v1/tasks/{id}/expanded': {
    request: (f) => ({ path: `/api/v1/tasks/${f.taskId}/expanded` }),
    expect: { ...orgScoped(204, 204), ...grants(204, 204, 404, 204) },
  },
  'PUT /api/v1/tasks/{id}/tags/{tagId}': {
    request: (f) => ({ path: `/api/v1/tasks/${f.taskId}/tags/${f.otherTagId}` }),
    expect: { ...orgScoped(200, 200), ...grants(403, 200, 404, 200) },
  },
  'DELETE /api/v1/tasks/{id}/tags/{tagId}': {
    request: (f) => ({ path: `/api/v1/tasks/${f.taskId}/tags/${f.tagId}` }),
    expect: { ...orgScoped(200, 200), ...grants(403, 200, 404, 200) },
  },
  'GET /api/v1/orgs/{orgId}/tags': {
    request: (f) => ({ path: `/api/v1/orgs/${f.orgId}/tags` }),
    expect: { ...orgScoped(200, 200), ...grants(200, 200, 404, 200) },
  },
  'POST /api/v1/orgs/{orgId}/tags': {
    request: (f) => ({ path: `/api/v1/orgs/${f.orgId}/tags`, body: { name: 'New tag' } }),
    expect: { ...orgScoped(201, 201), ...grants(403, 403, 404, 201) },
  },
  'PATCH /api/v1/tags/{id}': {
    request: (f) => ({ path: `/api/v1/tags/${f.tagId}`, body: { name: 'Renamed' } }),
    expect: { ...orgScoped(200, 200), ...grants(403, 403, 404, 200) },
  },
  'DELETE /api/v1/tags/{id}': {
    request: (f) => ({ path: `/api/v1/tags/${f.tagId}` }),
    expect: { ...orgScoped(204, 204), ...grants(403, 403, 404, 204) },
  },
  'POST /api/v1/tags/{id}/merge': {
    request: (f) => ({ path: `/api/v1/tags/${f.tagId}/merge`, body: { intoId: f.otherTagId } }),
    expect: { ...orgScoped(200, 200), ...grants(403, 403, 404, 200) },
  },
  // Phase 5: search, export and reindex (06 §2.8, ADR 0012).
  'GET /api/v1/search': {
    request: (f) => ({ path: `/api/v1/search?q=task&orgId=${f.orgId}` }),
    expect: { ...orgScoped(200, 200), ...grants(200, 200, 404, 200) },
  },
  'GET /api/v1/orgs/{orgId}/export': {
    request: (f) => ({ path: `/api/v1/orgs/${f.orgId}/export?format=json` }),
    expect: { ...orgScoped(200, 200), ...grants(403, 403, 403, 403) },
  },
  'POST /api/v1/admin/search/reindex': {
    request: () => ({ path: '/api/v1/admin/search/reindex' }),
    expect: { ...adminOnly(200), ...grants(403, 403, 403, 403) },
  },
  // Phase 6: collaboration (06 §2.6). Comments are written by any member and changed only
  // by their author (the owner here); notifications and prefs are the caller's own.
  'GET /api/v1/tasks/{id}/activity': {
    request: (f) => ({ path: `/api/v1/tasks/${f.taskId}/activity` }),
    expect: { ...orgScoped(200, 200), ...grants(200, 200, 404, 200) },
  },
  'POST /api/v1/tasks/{id}/comments': {
    request: (f) => ({ path: `/api/v1/tasks/${f.taskId}/comments`, body: { body: 'Hi' } }),
    expect: { ...orgScoped(201, 201), ...grants(403, 201, 404, 201) },
  },
  'PATCH /api/v1/comments/{id}': {
    request: (f) => ({ path: `/api/v1/comments/${f.commentId}`, body: { body: 'Edited' } }),
    expect: { ...orgScoped(403, 200), ...grants(403, 200, 404, 200) },
  },
  'DELETE /api/v1/comments/{id}': {
    request: (f) => ({ path: `/api/v1/comments/${f.commentId}` }),
    expect: { ...orgScoped(403, 204), ...grants(403, 204, 404, 204) },
  },
  'POST /api/v1/comments/{id}/restore': {
    request: (f) => ({ path: `/api/v1/comments/${f.deletedCommentId}/restore` }),
    expect: { ...orgScoped(403, 200), ...grants(403, 200, 404, 200) },
  },
  'PUT /api/v1/tasks/{id}/followers/me': {
    request: (f) => ({ path: `/api/v1/tasks/${f.taskId}/followers/me` }),
    expect: { ...orgScoped(200, 200), ...grants(403, 200, 404, 200) },
  },
  'DELETE /api/v1/tasks/{id}/followers/me': {
    request: (f) => ({ path: `/api/v1/tasks/${f.taskId}/followers/me` }),
    expect: { ...orgScoped(200, 200), ...grants(403, 200, 404, 200) },
  },
  'GET /api/v1/notifications': {
    request: () => ({ path: '/api/v1/notifications' }),
    expect: { ...signedIn(200), ...grants(403, 200, 200, 200) },
  },
  'POST /api/v1/notifications/read': {
    request: () => ({ path: '/api/v1/notifications/read', body: { all: true } }),
    expect: { ...signedIn(200), ...grants(403, 200, 200, 200) },
  },
  'POST /api/v1/notifications/unread': {
    request: () => ({ path: '/api/v1/notifications/unread', body: { all: true } }),
    expect: { ...signedIn(200), ...grants(403, 200, 200, 200) },
  },
  'GET /api/v1/me/notification-prefs': {
    request: () => ({ path: '/api/v1/me/notification-prefs' }),
    expect: { ...signedIn(200), ...grants(403, 403, 403, 403) },
  },
  'PUT /api/v1/me/notification-prefs': {
    request: () => ({
      path: '/api/v1/me/notification-prefs',
      body: { prefs: [{ type: 'comment', channel: 'inapp', enabled: false }] },
    }),
    expect: { ...signedIn(200), ...grants(403, 403, 403, 403) },
  },
  // Phase 7: delivery (06 §2.6, §2.10). Subscriptions are the caller's own: anyone else's is
  // 404, like a group.
  'GET /api/v1/push/vapid-public-key': {
    request: () => ({ path: '/api/v1/push/vapid-public-key' }),
    expect: { ...signedIn(200), ...grants(200, 200, 200, 200) },
  },
  'GET /api/v1/me/push-subscriptions': {
    request: () => ({ path: '/api/v1/me/push-subscriptions' }),
    expect: { ...signedIn(200), ...grants(403, 403, 403, 403) },
  },
  'POST /api/v1/me/push-subscriptions': {
    request: (_f, actor) => ({
      path: '/api/v1/me/push-subscriptions',
      body: subscriptionBody(actor),
    }),
    expect: { ...signedIn(201), ...grants(403, 403, 403, 403) },
  },
  'DELETE /api/v1/me/push-subscriptions/{id}': {
    request: (f) => ({ path: `/api/v1/me/push-subscriptions/${f.pushSubscriptionId}` }),
    expect: { ...owned(204), ...grants(403, 403, 403, 403) },
  },
  'POST /api/v1/me/push-subscriptions/{id}/test': {
    request: (f) => ({ path: `/api/v1/me/push-subscriptions/${f.pushSubscriptionId}/test` }),
    expect: { ...owned(204), ...grants(403, 403, 403, 403) },
  },
  'POST /api/v1/admin/push-keys/regenerate': {
    request: () => ({ path: '/api/v1/admin/push-keys/regenerate' }),
    expect: { ...adminOnly(200), ...grants(403, 403, 403, 403) },
  },
  // Phase 8: grants, PATs and devices (06 §2.1, 11 §3). Grants are the user's own (others'
  // are 404); a token may list them and revoke only itself; the rest needs the browser.
  'GET /api/v1/me/grants': {
    request: () => ({ path: '/api/v1/me/grants' }),
    expect: { ...signedIn(200), ...grants(200, 200, 200, 200) },
  },
  'PATCH /api/v1/me/grants/{id}': {
    request: (f) => ({ path: `/api/v1/me/grants/${f.spareGrantId}`, body: { label: 'Renamed' } }),
    expect: { ...owned(200), ...SESSION_ONLY },
  },
  'DELETE /api/v1/me/grants/{id}': {
    request: (f) => ({ path: `/api/v1/me/grants/${f.spareGrantId}` }),
    expect: { ...owned(204), ...SESSION_ONLY },
  },
  'POST /api/v1/me/tokens': {
    request: () => ({
      path: '/api/v1/me/tokens',
      body: { name: 'Script', scopes: ['tasks:read'], constraints: { orgs: 'all' } },
    }),
    // A CLI device may mint a PAT within its own grant (07 §4); PATs and apps may not.
    expect: { ...signedIn(201), ...grants(403, 403, 403, 201, 403) },
  },
  // Any signed-in browser may review and decide an unclaimed device code.
  'GET /api/v1/device/{userCode}': {
    request: (f) => ({ path: `/api/v1/device/${f.userCode}` }),
    expect: { ...signedIn(200), ...SESSION_ONLY },
  },
  'POST /api/v1/device/{userCode}/approve': {
    request: (f) => ({
      path: `/api/v1/device/${f.userCode}/approve`,
      body: { scopes: ['tasks:read'], constraints: { orgs: 'all' } },
    }),
    expect: { ...signedIn(200), ...SESSION_ONLY },
  },
  'POST /api/v1/device/{userCode}/deny': {
    request: (f) => ({ path: `/api/v1/device/${f.userCode}/deny` }),
    expect: { ...signedIn(204), ...SESSION_ONLY },
  },
  // Phase 9: the OAuth consent screen and linked identities, browser only (ADR 0042).
  'GET /api/v1/oauth/consent': {
    request: (f) => ({
      path: `/api/v1/oauth/consent?oauth_query=${encodeURIComponent(f.oauthQuery)}`,
    }),
    expect: { ...signedIn(200), ...SESSION_ONLY },
  },
  'POST /api/v1/oauth/consent': {
    request: (f) => ({
      path: '/api/v1/oauth/consent',
      body: { accept: false, oauthQuery: f.oauthQuery },
    }),
    expect: { ...signedIn(200), ...SESSION_ONLY },
  },
  'GET /api/v1/me/identities': {
    request: () => ({ path: '/api/v1/me/identities' }),
    expect: { ...signedIn(200), ...SESSION_ONLY },
  },
  'DELETE /api/v1/me/identities/{id}': {
    request: (f) => ({ path: `/api/v1/me/identities/${f.identityId}` }),
    // The owner's own identity (one of two); anyone else's is 404.
    expect: { ...owned(204), ...SESSION_ONLY },
  },
  'GET /api/v1/tasks/resolve': {
    request: (f) => ({ path: `/api/v1/tasks/resolve?ref=${f.taskId}` }),
    expect: { ...orgScoped(200, 200), ...grants(200, 200, 404, 200) },
  },
  // Phase 10 rows (tasks): skip, reminders.
  'POST /api/v1/tasks/{id}/skip': {
    request: (f) => ({ path: `/api/v1/tasks/${f.recurringTaskId}/skip`, body: {} }),
    expect: { ...orgScoped(200, 200), ...grants(403, 200, 404, 200) },
  },
  // Reminders are personal (ADR 0049 §2): any member sets their own on a task they can read;
  // grants need `tasks:write`, but no group write constraint applies.
  'GET /api/v1/tasks/{id}/reminders': {
    request: (f) => ({ path: `/api/v1/tasks/${f.taskId}/reminders` }),
    expect: { ...orgScoped(200, 200), ...grants(200, 200, 404, 200) },
  },
  'POST /api/v1/tasks/{id}/reminders': {
    request: (f) => ({
      path: `/api/v1/tasks/${f.taskId}/reminders`,
      body: { at: Date.now() + 2 * 3_600_000 },
    }),
    expect: { ...orgScoped(201, 201), ...grants(403, 201, 404, 201) },
  },
  // Someone else's reminder is not there for them (404).
  'DELETE /api/v1/tasks/{id}/reminders/{reminderId}': {
    request: (f) => ({ path: `/api/v1/tasks/${f.taskId}/reminders/${f.reminderId}` }),
    expect: { ...orgScoped(404, 204), ...grants(403, 204, 404, 204) },
  },
  // Phase 10 rows (files): attachments, avatars, calendar feeds. Uploading is an edit of
  // the task; downloading needs read access; deleting is for the uploader or the assignee.
  'POST /api/v1/tasks/{id}/attachments': {
    request: (f) => ({ path: `/api/v1/tasks/${f.taskId}/attachments`, body: textFile() }),
    expect: { ...orgScoped(201, 201), ...grants(403, 201, 404, 201) },
  },
  'GET /api/v1/attachments/{id}': {
    request: (f) => ({ path: `/api/v1/attachments/${f.attachmentId}` }),
    expect: { ...orgScoped(200, 200), ...grants(200, 200, 404, 200) },
    binary: 'image/png',
  },
  'GET /api/v1/attachments/{id}/thumb': {
    request: (f) => ({ path: `/api/v1/attachments/${f.attachmentId}/thumb` }),
    expect: { ...orgScoped(200, 200), ...grants(200, 200, 404, 200) },
    binary: 'image/webp',
  },
  // The member neither uploaded it nor is assigned: 403.
  'DELETE /api/v1/attachments/{id}': {
    request: (f) => ({ path: `/api/v1/attachments/${f.attachmentId}` }),
    expect: { ...orgScoped(403, 204), ...grants(403, 204, 404, 204) },
  },
  // The avatar is a profile setting (browser only); seeing one needs a shared org.
  'PUT /api/v1/me/avatar': {
    request: () => ({ path: '/api/v1/me/avatar', body: imageFile() }),
    expect: { ...signedIn(200), ...SESSION_ONLY },
  },
  'DELETE /api/v1/me/avatar': {
    request: () => ({ path: '/api/v1/me/avatar' }),
    expect: { ...signedIn(200), ...SESSION_ONLY },
  },
  'GET /api/v1/avatars/{userId}': {
    request: (f) => ({ path: `/api/v1/avatars/${f.avatarUserId}` }),
    expect: {
      anonymous: 401,
      disabled: 401,
      nonMember: 404,
      admin: 404,
      member: 200,
      owner: 200,
      ...grants(200, 200, 404, 200),
    },
    binary: 'image/webp',
  },
  // Calendar feeds are settings: browser only, and a feed is its owner's alone.
  'GET /api/v1/me/ical-feeds': {
    request: () => ({ path: '/api/v1/me/ical-feeds' }),
    expect: { ...signedIn(200), ...SESSION_ONLY },
  },
  'POST /api/v1/me/ical-feeds': {
    request: () => ({ path: '/api/v1/me/ical-feeds', body: {} }),
    expect: { ...signedIn(201), ...SESSION_ONLY },
  },
  'DELETE /api/v1/me/ical-feeds/{id}': {
    request: (f) => ({ path: `/api/v1/me/ical-feeds/${f.icalFeedId}` }),
    expect: { ...owned(204), ...SESSION_ONLY },
  },
};

/** A 1 × 1 PNG. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** Multipart bodies for the upload rows (sent as is, never as JSON). */
function textFile(): FormData {
  const form = new FormData();
  form.append('file', new File(['matrix'], 'matrix.txt', { type: 'text/plain' }));
  return form;
}

function imageFile(): FormData {
  const form = new FormData();
  form.append('file', new File([new Uint8Array(PNG_1PX)], 'me.png', { type: 'image/png' }));
  return form;
}

const dataDirs: (() => void)[] = [];
afterAll(() => {
  for (const cleanup of dataDirs) cleanup();
});

function actorFor(app: App, userId: string, sessionId: string): Actor {
  const actor = app.services.users.resolveActor(userId, sessionId);
  if (actor === null) throw new Error('fixture actor');
  return actor;
}

/** Shared org "Shared": owner, member, other member and disabled (former) member. */
async function fixture(): Promise<Fixture> {
  const dataDir = tempDir();
  dataDirs.push(dataDir.cleanup);
  const { app, db } = createTestApp({
    env: { ROOSTER_ADMIN_EMAILS: 'admin@example.com', ROOSTER_DATA_DIR: dataDir.path },
  });
  const make = (email: string) => createUserWithSession(app, db, { email });
  const owner = make('owner@example.com');
  const member = make('member@example.com');
  const other = make('other@example.com');
  const nonMember = make('outsider@example.com');
  const admin = make('admin@example.com');
  const disabled = make('disabled@example.com');

  const { orgs, admin: adminService } = app.services;
  const ownerActor = actorFor(app, owner.userId, owner.sessionId);
  const org = orgs.create(ownerActor, { name: 'Shared' });
  for (const u of [member, other, disabled]) {
    const { url } = orgs.createInvite(ownerActor, org.id, { role: 'member' });
    orgs.acceptInvite(actorFor(app, u.userId, u.sessionId), url.split('/invite/')[1] ?? '');
  }
  const link = orgs.createInvite(ownerActor, org.id, { role: 'member', multiUse: true });
  const adminActor = actorFor(app, admin.userId, admin.sessionId);
  const entry = adminService.addAllowlist(adminActor, {
    kind: 'email',
    value: 'listed@example.com',
  });
  const backup = app.services.backups.createManual(adminActor);
  const subscription = app.services.push.subscribe(ownerActor, subscriptionBody('owner'), null);

  const meta = { editTime: Date.now(), clientId: null, client: null };
  const { groups, tasks } = app.services;
  const groupA = groups.create(ownerActor, org.id, { name: 'A' }).group.id;
  const groupB = groups.create(ownerActor, org.id, { name: 'B' }).group.id;
  const deleted = groups.create(ownerActor, org.id, { name: 'Gone' }).group.id;
  groups.remove(ownerActor, deleted, {}, meta);
  const task = tasks.create(ownerActor, org.id, { title: 'Task', groupId: groupA });
  const trashed = tasks.create(ownerActor, org.id, { title: 'Trashed' });
  tasks.remove(ownerActor, trashed.id, meta);
  const tag = app.services.tags.create(ownerActor, org.id, { name: 'Tag' });
  const otherTag = app.services.tags.create(ownerActor, org.id, { name: 'Other tag' });
  app.services.tags.setOnTask(ownerActor, task.id, tag.id, true);
  const subtask = tasks.create(ownerActor, org.id, { title: 'Subtask', parentId: task.id });
  tasks.create(ownerActor, org.id, { title: 'Sibling', parentId: task.id });
  const { comments } = app.services;
  const comment = comments.create(ownerActor, task.id, { body: 'Comment' });
  const deletedComment = comments.create(ownerActor, task.id, { body: 'Deleted' });
  comments.remove(ownerActor, deletedComment.id);

  // The owner's non-browser credentials (P8).
  const personalOrg = orgs.list(ownerActor).find((o) => o.isPersonal)?.id ?? '';
  const pat = (scopes: GrantScope[], constraints: GrantConstraints) =>
    app.services.grants.createToken(ownerActor, { name: 'Matrix', scopes, constraints });
  const readOnlyPat = await pat(['tasks:read'], { orgs: 'all' });
  const writeInGroupPat = await pat(ALL_SCOPES, {
    orgs: [{ orgId: org.id, read: 'all', write: { groups: [groupA] } }],
  });
  const otherOrgPat = await pat(ALL_SCOPES, {
    orgs: [{ orgId: personalOrg, read: 'all', write: 'all' }],
  });
  const expiredPat = await pat(['tasks:read'], { orgs: 'all' });
  db.orm
    .update(accessGrant)
    .set({ expiresAt: 1 })
    .where(eq(accessGrant.id, expiredPat.grant.id))
    .run();
  const revokedPat = await pat(['tasks:read'], { orgs: 'all' });
  app.services.grants.revoke(ownerActor, revokedPat.grant.id);
  const spare = await pat(['tasks:read'], { orgs: 'all' });
  const now = Date.now();
  const deviceGrantId = uuidv7();
  db.orm
    .insert(accessGrant)
    .values({
      id: deviceGrantId,
      userId: owner.userId,
      kind: 'device',
      clientId: 'rooster-cli',
      label: 'rooster CLI',
      scopes: ALL_SCOPES.join(' '),
      constraints: '{"orgs":"all"}',
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const deviceToken = randomToken();
  db.orm
    .insert(session)
    .values({
      id: uuidv7(),
      token: deviceToken,
      userId: owner.userId,
      expiresAt: new Date(now + 86_400_000),
      createdAt: new Date(now),
      updatedAt: new Date(now),
      grantId: deviceGrantId,
    })
    .run();
  const browserToken =
    db.orm.select().from(session).where(eq(session.id, owner.sessionId)).get()?.token ?? '';
  const userCode = 'MATRIXCD';
  db.orm
    .insert(deviceCode)
    .values({
      id: uuidv7(),
      deviceCode: randomToken(),
      userCode,
      expiresAt: new Date(now + 600_000),
      status: 'pending',
      pollingInterval: 5000,
      clientId: 'rooster-cli',
      scope: 'tasks:read tasks:write',
    })
    .run();

  // P9: an OAuth app of the owner (every app scope, everywhere) with a token per resource, a
  // signed authorization request for the consent routes, and two linked identities.
  const appClientId = 'matrix-app';
  db.orm
    .insert(oauthClient)
    .values({
      id: uuidv7(),
      clientId: appClientId,
      name: 'Matrix app',
      redirectUris: JSON.stringify(['https://app.example.com/callback']),
      tokenEndpointAuthMethod: 'none',
      grantTypes: JSON.stringify(['authorization_code', 'refresh_token']),
      responseTypes: JSON.stringify(['code']),
      scopes: JSON.stringify([...ALL_SCOPES, 'offline_access']),
      createdAt: new Date(now),
      updatedAt: new Date(now),
    })
    .run();
  const appGrantId = uuidv7();
  db.orm
    .insert(accessGrant)
    .values({
      id: appGrantId,
      userId: owner.userId,
      kind: 'oauth',
      clientId: appClientId,
      label: 'Matrix app',
      scopes: ALL_SCOPES.join(' '),
      constraints: '{"orgs":"all"}',
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const appToken = (resource: string) => {
    const raw = randomToken();
    db.orm
      .insert(oauthAccessToken)
      .values({
        id: uuidv7(),
        token: hashOAuthToken(raw),
        clientId: appClientId,
        userId: owner.userId,
        referenceId: appGrantId,
        resources: JSON.stringify([resource]),
        scopes: JSON.stringify(ALL_SCOPES),
        createdAt: new Date(now),
        expiresAt: new Date(now + 900_000),
      })
      .run();
    return `${OAUTH_ACCESS_PREFIX}${raw}`;
  };
  const authorize = await app.request(
    `/api/auth/oauth2/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: appClientId,
      redirect_uri: 'https://app.example.com/callback',
      scope: 'tasks:read',
      resource: `${TEST_ENV.ROOSTER_BASE_URL}/mcp`,
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
    })}`,
    { headers: { cookie: owner.jar.header() } },
  );
  const consentPage = new URL(authorize.headers.get('location') ?? '', TEST_ENV.ROOSTER_BASE_URL);
  if (consentPage.pathname !== '/oauth/consent') throw new Error(`authorize: ${consentPage.href}`);
  const identity = (providerId: string) => {
    const id = uuidv7();
    db.orm
      .insert(account)
      .values({
        id,
        accountId: `${providerId}-${owner.userId}`,
        providerId,
        userId: owner.userId,
        createdAt: new Date(now),
        updatedAt: new Date(now),
      })
      .run();
    return id;
  };
  identity('google');
  const identityId = identity('dev');

  // P10 setup (tasks): reminders.
  const recurring = tasks.create(ownerActor, org.id, {
    title: 'Weekly',
    groupId: groupA,
    dueDate: '2026-10-09',
    recurrence: 'FREQ=WEEKLY',
  });
  const { reminder } = app.services.reminders.create(ownerActor, task.id, {
    at: Date.now() + 3_600_000,
  });

  // P10 setup (files): attachments, avatars, calendar feeds.
  const bigPng = new Uint8Array(
    await sharp({ create: { width: 64, height: 48, channels: 3, background: '#c33' } })
      .png()
      .toBuffer(),
  );
  const imageForm = new FormData();
  imageForm.append('file', new File([bigPng], 'photo.png', { type: 'image/png' }));
  const uploaded = await app.request(
    `/api/v1/tasks/${task.id}/attachments`,
    asJar(owner.jar, { method: 'POST', body: imageForm }),
  );
  if (uploaded.status !== 201) throw new Error(`fixture upload: ${await uploaded.text()}`);
  const attachmentId = ((await uploaded.json()) as { id: string }).id;
  const avatar = await app.request(
    '/api/v1/me/avatar',
    asJar(other.jar, { method: 'PUT', body: imageFile() }),
  );
  if (avatar.status !== 200) throw new Error(`fixture avatar: ${await avatar.text()}`);
  const icalFeedId = app.services.icalFeeds.create(ownerActor, {}).feed.id;

  // A disabled user whose session somehow survived must still be rejected.
  db.orm.update(user).set({ disabledAt: Date.now() }).where(eq(user.id, disabled.userId)).run();
  const disabledJar = new CookieJar();
  const disabledSession = addSession(
    db,
    disabled.userId,
    disabledJar,
    TEST_ENV.ROOSTER_AUTH_SECRET,
  );

  return {
    app,
    db,
    orgId: org.id,
    otherMemberId: other.userId,
    inviteId: link.id,
    inviteToken: link.url.split('/invite/')[1] ?? '',
    allowlistId: entry.id,
    groupId: groupA,
    otherGroupId: groupB,
    deletedGroupId: deleted,
    taskId: task.id,
    trashedTaskId: trashed.id,
    subtaskId: subtask.id,
    tagId: tag.id,
    otherTagId: otherTag.id,
    commentId: comment.id,
    deletedCommentId: deletedComment.id,
    backupName: backup.name,
    pushSubscriptionId: subscription.id,
    spareGrantId: spare.grant.id,
    userCode,
    oauthQuery: consentPage.search.slice(1),
    identityId,
    // P10 fixtures (tasks).
    recurringTaskId: recurring.id,
    reminderId: reminder.id,
    // P10 fixtures (files).
    attachmentId,
    avatarUserId: other.userId,
    icalFeedId,
    tokens: {
      readOnlyPat: readOnlyPat.token,
      writeInGroupPat: writeInGroupPat.token,
      otherOrgPat: otherOrgPat.token,
      device: deviceToken,
      expiredPat: expiredPat.token,
      revokedPat: revokedPat.token,
      browserBearer: browserToken,
      oauthApp: appToken(`${TEST_ENV.ROOSTER_BASE_URL}/api/v1`),
      mcpAudienceToken: appToken(`${TEST_ENV.ROOSTER_BASE_URL}/mcp`),
    },
    jars: {
      owner: owner.jar,
      member: member.jar,
      nonMember: nonMember.jar,
      admin: admin.jar,
      disabled: disabledJar,
    },
    sessions: {
      owner: owner.sessionId,
      member: member.sessionId,
      nonMember: nonMember.sessionId,
      admin: admin.sessionId,
      disabled: disabledSession,
    },
  };
}

type ZodLike = { safeParse(v: unknown): { success: boolean; error?: unknown } };

/** The declared JSON response schema of a route for a status, from the zod-openapi registry. */
function responseSchema(app: App, route: string, status: number): ZodLike | undefined {
  const [method = '', path = ''] = route.split(' ');
  for (const def of app.openAPIRegistry.definitions) {
    if (def.type !== 'route') continue;
    if (def.route.method.toUpperCase() !== method || def.route.path !== path) continue;
    const response = def.route.responses[status] as
      | { content?: Record<string, { schema?: unknown }> }
      | undefined;
    return response?.content?.['application/json']?.schema as ZodLike | undefined;
  }
  return undefined;
}

async function documentedRoutes(): Promise<string[]> {
  const { app } = createTestApp();
  const doc = (await (await app.request('/api/v1/openapi.json')).json()) as {
    paths: Record<string, Record<string, unknown>>;
  };
  return Object.entries(doc.paths).flatMap(([path, ops]) =>
    Object.keys(ops).map((method) => `${method.toUpperCase()} ${path}`),
  );
}

describe('AC-1.6 authorisation matrix', () => {
  it('has a row for every route in the OpenAPI document, and no stale rows', async () => {
    const routes = (await documentedRoutes()).filter((r) => r.includes(' /api/v1/'));
    expect(routes.filter((r) => !(r in ROWS))).toEqual([]);
    expect(Object.keys(ROWS).filter((r) => !routes.includes(r))).toEqual([]);
  });

  const cases = Object.entries(ROWS).flatMap(([route, row]) =>
    ACTORS.map((actor) => ({ route, row, actor, expected: row.expect[actor] })),
  );

  it.each(cases)('$route as $actor → $expected', async ({ route, row, actor, expected }) => {
    const f = await fixture();
    const [method = 'GET'] = route.split(' ');
    const { path, body } = row.request(f, actor);
    // Upload rows send multipart bodies as they are (P10).
    const form = body instanceof FormData;
    const payload =
      body === undefined ? {} : { body: form ? (body as FormData) : JSON.stringify(body) };
    // Token actors are not browsers: a bearer header, no cookie, no Origin.
    const init: RequestInit = TOKEN_ACTORS.has(actor)
      ? {
          method,
          ...payload,
          headers: {
            authorization: `Bearer ${f.tokens[actor as TokenActor]}`,
            ...(body === undefined || form ? {} : { 'content-type': 'application/json' }),
          },
        }
      : asJar(actor === 'anonymous' ? new CookieJar() : f.jars[actor as CookieActor], {
          method,
          ...payload,
        });
    const res = await f.app.request(path, init);
    if (row.stream !== undefined && res.status === 200) {
      expect(res.headers.get('content-type')).toBe(row.stream);
      await res.body?.cancel();
      expect(res.status).toBe(expected);
      return;
    }
    expect(res.status, await res.clone().text()).toBe(expected);
    if (expected >= 400) {
      expect(res.headers.get('content-type')).toBe('application/problem+json');
    } else if (row.binary !== undefined) {
      expect(res.headers.get('content-type')).toBe(row.binary);
    } else if (expected !== 204) {
      // Contract: the real response matches the declared schema (06 §4).
      const schema = responseSchema(f.app, route, expected);
      expect(schema, `${route} declares no ${expected} schema`).toBeDefined();
      const parsed = schema?.safeParse(await res.json());
      expect(parsed?.success, JSON.stringify(parsed?.error)).toBe(true);
    }
  });
});
