// AC-1.6, 10 §3.3: every route in the OpenAPI document × every kind of actor. A route
// without a row here fails the "covers every route" test.
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app.ts';
import type { AppDb } from '../src/db/client.ts';
import { user } from '../src/db/schema/index.ts';
import type { Actor } from '../src/services/index.ts';
import {
  addSession,
  asJar,
  CookieJar,
  createTestApp,
  createUserWithSession,
  TEST_ENV,
  tempDir,
} from './helpers.ts';

const ACTORS = [
  'anonymous',
  'disabled',
  'nonMember',
  'member',
  'owner',
  'admin',
  'readOnlyPat',
] as const;
type ActorKind = (typeof ACTORS)[number];

/** `skip`: the actor kind does not exist yet (PATs arrive in Phase 8). */
type Expected = number | 'skip';

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
  jars: Record<Exclude<ActorKind, 'anonymous' | 'readOnlyPat'>, CookieJar>;
  sessions: Record<Exclude<ActorKind, 'anonymous' | 'readOnlyPat'>, string>;
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
  readOnlyPat: 'skip',
});

/** Any signed-in, enabled user. */
const signedIn = (status: number): Record<ActorKind, Expected> => ({
  ...everyone(status),
  anonymous: 401,
  disabled: 401,
});

/** Org-scoped: non-members (the admin included) get 404 (04 §4.3). */
const orgScoped = (member: number, owner: number): Record<ActorKind, Expected> => ({
  anonymous: 401,
  disabled: 401,
  nonMember: 404,
  admin: 404,
  member,
  owner,
  readOnlyPat: 'skip',
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
  readOnlyPat: 'skip',
});

const ROWS: Record<string, Row> = {
  'GET /api/v1/meta': { request: () => ({ path: '/api/v1/meta' }), expect: everyone(200) },
  'GET /api/v1/invites/{token}': {
    request: (f) => ({ path: `/api/v1/invites/${f.inviteToken}` }),
    expect: everyone(200),
  },
  'POST /api/v1/invites/{token}/claim': {
    request: (f) => ({ path: `/api/v1/invites/${f.inviteToken}/claim` }),
    expect: everyone(200),
  },
  'POST /api/v1/invites/{token}/accept': {
    request: (f) => ({ path: `/api/v1/invites/${f.inviteToken}/accept` }),
    // Anyone signed in may join through a valid link; members are a no-op.
    expect: signedIn(200),
  },
  'GET /api/v1/me': { request: () => ({ path: '/api/v1/me' }), expect: signedIn(200) },
  // Anyone signed in may listen; what reaches them is targeted per user (events.test.ts).
  'GET /api/v1/events': {
    request: () => ({ path: '/api/v1/events' }),
    expect: signedIn(200),
    stream: 'text/event-stream',
  },
  'PATCH /api/v1/me': {
    request: () => ({ path: '/api/v1/me', body: { name: 'Renamed' } }),
    expect: signedIn(200),
  },
  'GET /api/v1/me/sessions': {
    request: () => ({ path: '/api/v1/me/sessions' }),
    expect: signedIn(200),
  },
  'DELETE /api/v1/me/sessions/{id}': {
    request: (f, actor) => ({
      path: `/api/v1/me/sessions/${actor === 'anonymous' || actor === 'readOnlyPat' ? f.sessions.owner : f.sessions[actor]}`,
    }),
    expect: signedIn(204),
  },
  'PUT /api/v1/me/org-order': {
    request: (f) => ({ path: '/api/v1/me/org-order', body: { orgId: f.orgId } }),
    expect: orgScoped(200, 200),
  },
  'PATCH /api/v1/me/orgs/{orgId}': {
    request: (f) => ({ path: `/api/v1/me/orgs/${f.orgId}`, body: { collapsed: true } }),
    expect: orgScoped(200, 200),
  },
  'GET /api/v1/orgs': { request: () => ({ path: '/api/v1/orgs' }), expect: signedIn(200) },
  'POST /api/v1/orgs': {
    request: () => ({ path: '/api/v1/orgs', body: { name: 'New org' } }),
    expect: signedIn(201),
  },
  'PATCH /api/v1/orgs/{orgId}': {
    request: (f) => ({ path: `/api/v1/orgs/${f.orgId}`, body: { name: 'Renamed' } }),
    expect: orgScoped(403, 200),
  },
  'DELETE /api/v1/orgs/{orgId}': {
    request: (f) => ({ path: `/api/v1/orgs/${f.orgId}`, body: { confirmName: 'Shared' } }),
    expect: orgScoped(403, 204),
  },
  'GET /api/v1/orgs/{orgId}/members': {
    request: (f) => ({ path: `/api/v1/orgs/${f.orgId}/members` }),
    expect: orgScoped(200, 200),
  },
  'PATCH /api/v1/orgs/{orgId}/members/{userId}': {
    request: (f) => ({
      path: `/api/v1/orgs/${f.orgId}/members/${f.otherMemberId}`,
      body: { role: 'owner' },
    }),
    expect: orgScoped(403, 200),
  },
  'DELETE /api/v1/orgs/{orgId}/members/{userId}': {
    request: (f) => ({ path: `/api/v1/orgs/${f.orgId}/members/${f.otherMemberId}` }),
    expect: orgScoped(403, 204),
  },
  'GET /api/v1/orgs/{orgId}/invites': {
    request: (f) => ({ path: `/api/v1/orgs/${f.orgId}/invites` }),
    expect: orgScoped(403, 200),
  },
  'POST /api/v1/orgs/{orgId}/invites': {
    request: (f) => ({ path: `/api/v1/orgs/${f.orgId}/invites`, body: { role: 'member' } }),
    expect: orgScoped(403, 201),
  },
  'DELETE /api/v1/orgs/{orgId}/invites/{id}': {
    request: (f) => ({ path: `/api/v1/orgs/${f.orgId}/invites/${f.inviteId}` }),
    expect: orgScoped(403, 204),
  },
  'GET /api/v1/admin/allowlist': {
    request: () => ({ path: '/api/v1/admin/allowlist' }),
    expect: adminOnly(200),
  },
  'POST /api/v1/admin/allowlist': {
    request: () => ({
      path: '/api/v1/admin/allowlist',
      body: { kind: 'domain', value: 'new.example' },
    }),
    expect: adminOnly(201),
  },
  'DELETE /api/v1/admin/allowlist/{id}': {
    request: (f) => ({ path: `/api/v1/admin/allowlist/${f.allowlistId}` }),
    expect: adminOnly(204),
  },
  'GET /api/v1/admin/users': {
    request: () => ({ path: '/api/v1/admin/users' }),
    expect: adminOnly(200),
  },
  'PATCH /api/v1/admin/users/{id}': {
    request: (f) => ({ path: `/api/v1/admin/users/${f.otherMemberId}`, body: { disabled: true } }),
    expect: adminOnly(200),
  },
  'GET /api/v1/admin/backups': {
    request: () => ({ path: '/api/v1/admin/backups' }),
    expect: adminOnly(200),
  },
  'POST /api/v1/admin/backups': {
    request: () => ({ path: '/api/v1/admin/backups' }),
    expect: adminOnly(201),
  },
  'GET /api/v1/admin/backups/{name}': {
    request: (f) => ({ path: `/api/v1/admin/backups/${f.backupName}` }),
    expect: adminOnly(200),
    binary: 'application/vnd.sqlite3',
  },
  // Phase 2: the list. Tasks are visible to every member of their org; groups and
  // placements only to their owner.
  'GET /api/v1/orgs/{orgId}/my-list': {
    request: (f) => ({ path: `/api/v1/orgs/${f.orgId}/my-list` }),
    expect: orgScoped(200, 200),
  },
  'POST /api/v1/orgs/{orgId}/groups': {
    request: (f) => ({ path: `/api/v1/orgs/${f.orgId}/groups`, body: { name: 'New' } }),
    expect: orgScoped(201, 201),
  },
  'PATCH /api/v1/groups/{id}': {
    request: (f) => ({ path: `/api/v1/groups/${f.groupId}`, body: { name: 'Renamed' } }),
    expect: owned(200),
  },
  'POST /api/v1/groups/{id}/move': {
    request: (f) => ({ path: `/api/v1/groups/${f.groupId}/move`, body: { afterId: null } }),
    expect: owned(200),
  },
  'DELETE /api/v1/groups/{id}': {
    request: (f) => ({
      path: `/api/v1/groups/${f.groupId}`,
      body: { moveTasksTo: f.otherGroupId },
    }),
    expect: owned(204),
  },
  'POST /api/v1/groups/{id}/restore': {
    request: (f) => ({ path: `/api/v1/groups/${f.deletedGroupId}/restore` }),
    expect: owned(200),
  },
  'GET /api/v1/orgs/{orgId}/tasks': {
    request: (f) => ({ path: `/api/v1/orgs/${f.orgId}/tasks?view=today` }),
    expect: orgScoped(200, 200),
  },
  'POST /api/v1/orgs/{orgId}/tasks': {
    request: (f) => ({ path: `/api/v1/orgs/${f.orgId}/tasks`, body: { title: 'New task' } }),
    expect: orgScoped(201, 201),
  },
  'PATCH /api/v1/tasks/{id}': {
    request: (f) => ({ path: `/api/v1/tasks/${f.taskId}`, body: { title: 'Renamed' } }),
    expect: orgScoped(200, 200),
  },
  'POST /api/v1/tasks/{id}/move': {
    request: (f) => ({ path: `/api/v1/tasks/${f.taskId}/move`, body: { groupId: f.otherGroupId } }),
    // Only the owner has the task in their list.
    expect: orgScoped(404, 200),
  },
  'POST /api/v1/tasks/{id}/complete': {
    request: (f) => ({ path: `/api/v1/tasks/${f.taskId}/complete`, body: { completed: true } }),
    expect: orgScoped(200, 200),
  },
  'DELETE /api/v1/tasks/{id}': {
    request: (f) => ({ path: `/api/v1/tasks/${f.taskId}` }),
    expect: orgScoped(204, 204),
  },
  'POST /api/v1/tasks/{id}/restore': {
    request: (f) => ({ path: `/api/v1/tasks/${f.trashedTaskId}/restore` }),
    expect: orgScoped(200, 200),
  },
  'DELETE /api/v1/tasks/{id}/permanent': {
    request: (f) => ({ path: `/api/v1/tasks/${f.trashedTaskId}/permanent` }),
    expect: orgScoped(204, 204),
  },
  'POST /api/v1/tasks/bulk': {
    request: (f) => ({ path: '/api/v1/tasks/bulk', body: { op: 'complete', ids: [f.taskId] } }),
    // Per-task results: outsiders get `{ok: false, code: 'not_found'}` for each ID.
    expect: signedIn(200),
  },
  'GET /api/v1/orgs/{orgId}/trash': {
    request: (f) => ({ path: `/api/v1/orgs/${f.orgId}/trash` }),
    expect: orgScoped(200, 200),
  },
  // Phase 3: detail, subtasks, expansion and tags. Everything is org-scoped; expansion is
  // per user, so every member may expand any task they can see.
  'GET /api/v1/tasks/{id}': {
    request: (f) => ({ path: `/api/v1/tasks/${f.taskId}` }),
    expect: orgScoped(200, 200),
  },
  'POST /api/v1/tasks/{id}/reorder': {
    request: (f) => ({ path: `/api/v1/tasks/${f.subtaskId}/reorder`, body: { afterId: null } }),
    expect: orgScoped(200, 200),
  },
  'POST /api/v1/tasks/{id}/duplicate': {
    request: (f) => ({ path: `/api/v1/tasks/${f.taskId}/duplicate`, body: {} }),
    expect: orgScoped(201, 201),
  },
  'PUT /api/v1/tasks/{id}/expanded': {
    request: (f) => ({ path: `/api/v1/tasks/${f.taskId}/expanded` }),
    expect: orgScoped(204, 204),
  },
  'DELETE /api/v1/tasks/{id}/expanded': {
    request: (f) => ({ path: `/api/v1/tasks/${f.taskId}/expanded` }),
    expect: orgScoped(204, 204),
  },
  'PUT /api/v1/tasks/{id}/tags/{tagId}': {
    request: (f) => ({ path: `/api/v1/tasks/${f.taskId}/tags/${f.otherTagId}` }),
    expect: orgScoped(200, 200),
  },
  'DELETE /api/v1/tasks/{id}/tags/{tagId}': {
    request: (f) => ({ path: `/api/v1/tasks/${f.taskId}/tags/${f.tagId}` }),
    expect: orgScoped(200, 200),
  },
  'GET /api/v1/orgs/{orgId}/tags': {
    request: (f) => ({ path: `/api/v1/orgs/${f.orgId}/tags` }),
    expect: orgScoped(200, 200),
  },
  'POST /api/v1/orgs/{orgId}/tags': {
    request: (f) => ({ path: `/api/v1/orgs/${f.orgId}/tags`, body: { name: 'New tag' } }),
    expect: orgScoped(201, 201),
  },
  'PATCH /api/v1/tags/{id}': {
    request: (f) => ({ path: `/api/v1/tags/${f.tagId}`, body: { name: 'Renamed' } }),
    expect: orgScoped(200, 200),
  },
  'DELETE /api/v1/tags/{id}': {
    request: (f) => ({ path: `/api/v1/tags/${f.tagId}` }),
    expect: orgScoped(204, 204),
  },
  'POST /api/v1/tags/{id}/merge': {
    request: (f) => ({ path: `/api/v1/tags/${f.tagId}/merge`, body: { intoId: f.otherTagId } }),
    expect: orgScoped(200, 200),
  },
  // Phase 5: search, export and reindex (06 §2.8, ADR 0012).
  'GET /api/v1/search': {
    request: (f) => ({ path: `/api/v1/search?q=task&orgId=${f.orgId}` }),
    expect: orgScoped(200, 200),
  },
  'GET /api/v1/orgs/{orgId}/export': {
    request: (f) => ({ path: `/api/v1/orgs/${f.orgId}/export?format=json` }),
    expect: orgScoped(200, 200),
  },
  'POST /api/v1/admin/search/reindex': {
    request: () => ({ path: '/api/v1/admin/search/reindex' }),
    expect: adminOnly(200),
  },
  // Phase 6: collaboration (06 §2.6). Comments are written by any member and changed only
  // by their author (the owner here); notifications and prefs are the caller's own.
  'GET /api/v1/tasks/{id}/activity': {
    request: (f) => ({ path: `/api/v1/tasks/${f.taskId}/activity` }),
    expect: orgScoped(200, 200),
  },
  'POST /api/v1/tasks/{id}/comments': {
    request: (f) => ({ path: `/api/v1/tasks/${f.taskId}/comments`, body: { body: 'Hi' } }),
    expect: orgScoped(201, 201),
  },
  'PATCH /api/v1/comments/{id}': {
    request: (f) => ({ path: `/api/v1/comments/${f.commentId}`, body: { body: 'Edited' } }),
    expect: orgScoped(403, 200),
  },
  'DELETE /api/v1/comments/{id}': {
    request: (f) => ({ path: `/api/v1/comments/${f.commentId}` }),
    expect: orgScoped(403, 204),
  },
  'POST /api/v1/comments/{id}/restore': {
    request: (f) => ({ path: `/api/v1/comments/${f.deletedCommentId}/restore` }),
    expect: orgScoped(403, 200),
  },
  'PUT /api/v1/tasks/{id}/followers/me': {
    request: (f) => ({ path: `/api/v1/tasks/${f.taskId}/followers/me` }),
    expect: orgScoped(200, 200),
  },
  'DELETE /api/v1/tasks/{id}/followers/me': {
    request: (f) => ({ path: `/api/v1/tasks/${f.taskId}/followers/me` }),
    expect: orgScoped(200, 200),
  },
  'GET /api/v1/notifications': {
    request: () => ({ path: '/api/v1/notifications' }),
    expect: signedIn(200),
  },
  'POST /api/v1/notifications/read': {
    request: () => ({ path: '/api/v1/notifications/read', body: { all: true } }),
    expect: signedIn(200),
  },
  'POST /api/v1/notifications/unread': {
    request: () => ({ path: '/api/v1/notifications/unread', body: { all: true } }),
    expect: signedIn(200),
  },
  'GET /api/v1/me/notification-prefs': {
    request: () => ({ path: '/api/v1/me/notification-prefs' }),
    expect: signedIn(200),
  },
  'PUT /api/v1/me/notification-prefs': {
    request: () => ({
      path: '/api/v1/me/notification-prefs',
      body: { prefs: [{ type: 'comment', channel: 'inapp', enabled: false }] },
    }),
    expect: signedIn(200),
  },
};

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
function fixture(): Fixture {
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
    if (expected === 'skip') return;
    const f = fixture();
    const [method = 'GET'] = route.split(' ');
    const { path, body } = row.request(f, actor);
    const jar = actor === 'anonymous' || actor === 'readOnlyPat' ? new CookieJar() : f.jars[actor];
    const init = asJar(jar, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
