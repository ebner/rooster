// 10 §3, 06 §4, WP 8.1: every route in the OpenAPI document is exercised on its happy path
// and on every documented error status, and each real response is checked against the
// document: the declared status, media type and schema, the documented problem codes, and
// the required response headers. A route without an entry in SPECS fails the test, like the
// authorisation matrix. The second half checks the document itself (descriptions, examples).
import { uuidv7 } from '@rooster/core/ids';
import type {
  GrantConstraintsValue,
  GrantScopeValue as GrantScope,
  TokenCreated,
} from '@rooster/core/schemas';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app.ts';
import type { AppDb } from '../src/db/client.ts';
import { account, attachment, oauthClient } from '../src/db/schema/index.ts';
import { NAMED_SCHEMAS } from '../src/lib/openapi.ts';
import { checkResponse, type RouteContract, routeContracts } from '../src/lib/response-contract.ts';
import type { Actor } from '../src/services/index.ts';
import type { FakePush } from './delivery-fakes.ts';
import { fcmEndpoint, subscriptionBody } from './delivery-fakes.ts';
import {
  addSession,
  BASE_URL,
  CookieJar,
  createTestApp,
  createUserWithSession,
  TEST_ENV,
  tempDir,
} from './helpers.ts';

type ActorKind = 'anonymous' | 'owner' | 'member' | 'nonMember' | 'admin';

interface FixtureOptions {
  /** Every authenticated request is over the per-user limit (`429`). */
  rateLimited?: boolean;
  env?: Record<string, string>;
}

interface Fixture {
  app: App;
  db: AppDb;
  push: FakePush;
  orgId: string;
  orgSlug: string;
  /** Another org of the owner, whose slug a rename can collide with. */
  otherOrgSlug: string;
  ownerId: string;
  adminId: string;
  otherMemberId: string;
  /** A second session of the owner, safe to revoke. */
  spareSessionId: string;
  inviteId: string;
  inviteToken: string;
  allowlistId: string;
  inboxId: string;
  groupId: string;
  otherGroupId: string;
  deletedGroupId: string;
  taskId: string;
  otherTaskId: string;
  trashedTaskId: string;
  personalTaskId: string;
  subtaskId: string;
  tagId: string;
  otherTagId: string;
  commentId: string;
  deletedCommentId: string;
  /** The owner's comment on the trashed task. */
  trashedTaskCommentId: string;
  backupName: string;
  pushSubscriptionId: string;
  taskSeq: number;
  jars: Record<Exclude<ActorKind, 'anonymous'>, CookieJar>;
  actors: Record<'owner' | 'admin' | 'member', Actor>;
  /** Bearer credentials minted by a case's setup (PATs, device sessions), by name. */
  bearer: Record<string, string>;
  /** Set by setups: a pending device request's user code, and a grant of the owner. */
  userCode: string;
  grantId: string;
  /** Set by setups (P9): an app's signed authorization request, a linked identity. */
  oauthQuery: string;
  identityId: string;
}

interface Req {
  path: string;
  body?: unknown;
  /** Sent as is, instead of `body`. */
  rawBody?: string;
  /** P10 uploads: a multipart body, sent as is (it sets its own Content-Type). */
  form?: FormData;
  headers?: Record<string, string>;
  /** Default: the route's actor (the owner unless the spec says otherwise). */
  as?: ActorKind;
  /** Sent as `Authorization: Bearer`, without a cookie or Origin (a PAT or device session). */
  bearer?: string | undefined;
}

interface Case {
  name: string;
  status: number;
  request: (f: Fixture) => Req;
  setup?: (f: Fixture) => void | Promise<void>;
  /** The problem code the response must carry. */
  code?: string;
  fixture?: FixtureOptions;
}

interface Spec {
  ok: (f: Fixture) => Req;
  /** The actor of every case of this route unless a case says otherwise. */
  as?: ActorKind;
  setup?: (f: Fixture) => void | Promise<void>;
  fixture?: FixtureOptions;
  /** Specific error paths and further happy paths. */
  cases?: (Partial<Case> & { status: number })[];
  /**
   * Statuses whose generic case does not apply, so a specific case is required: an upload's
   * `413` comes from its multipart file, not from the generic oversized JSON body (P10).
   */
  noGeneric?: number[];
}

const fresh = () => uuidv7();
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
 * Mints a PAT of the owner, as `POST /me/tokens` does for the browser session (that route has
 * its own cases). Through the service, so it works in a rate-limited fixture too.
 */
async function mintPat(
  f: Fixture,
  scopes: GrantScope[],
  constraints: GrantConstraintsValue = { orgs: 'all' },
): Promise<TokenCreated> {
  return f.app.services.grants.createToken(f.actors.owner, {
    name: 'Contract',
    scopes,
    constraints,
  });
}

/** The CLI's device code request (RFC 8628); stores the user code in the fixture. */
async function startDevice(f: Fixture, scope = 'tasks:read tasks:write'): Promise<string> {
  const res = await f.app.request('/api/auth/device/code', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'rooster-cli/1.0.0 (linux; x64; laptop)',
    },
    body: JSON.stringify({ client_id: 'rooster-cli', scope }),
  });
  if (res.status !== 200) throw new Error(`device code: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { user_code: string; device_code: string };
  f.userCode = body.user_code;
  return body.device_code;
}

/** A CLI device session of the owner with the given approval: its bearer token. */
async function deviceSession(
  f: Fixture,
  approval: { scopes: GrantScope[]; constraints: GrantConstraintsValue },
): Promise<string> {
  const deviceCode = await startDevice(f, ALL_SCOPES.join(' '));
  const approve = await send(
    f,
    'POST',
    { path: `/api/v1/device/${f.userCode}/approve`, body: approval },
    'owner',
  );
  if (approve.status !== 200) throw new Error(`approve: ${approve.status}`);
  const res = await f.app.request('/api/auth/device/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
      client_id: 'rooster-cli',
    }),
  });
  const body = (await res.json()) as { access_token?: string };
  if (body.access_token === undefined) throw new Error(`device token: ${JSON.stringify(body)}`);
  return body.access_token;
}

/**
 * P9: an app (an `oauthClient` row) and the owner's authorization request for it, as the
 * provider signed it for the consent screen; stored in `f.oauthQuery`.
 */
async function startConsent(f: Fixture): Promise<void> {
  f.db.orm
    .insert(oauthClient)
    .values({
      id: uuidv7(),
      clientId: 'contract-app',
      name: 'Contract app',
      redirectUris: JSON.stringify(['https://app.example.com/callback']),
      tokenEndpointAuthMethod: 'none',
      grantTypes: JSON.stringify(['authorization_code', 'refresh_token']),
      responseTypes: JSON.stringify(['code']),
      scopes: JSON.stringify([...ALL_SCOPES, 'offline_access']),
    })
    .run();
  const res = await f.app.request(
    `/api/auth/oauth2/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: 'contract-app',
      redirect_uri: 'https://app.example.com/callback',
      scope: 'tasks:read',
      resource: `${BASE_URL}/mcp`,
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
    })}`,
    { headers: { cookie: f.jars.owner.header() } },
  );
  const page = new URL(res.headers.get('location') ?? '', BASE_URL);
  if (page.pathname !== '/oauth/consent') throw new Error(`authorize: ${page.href}`);
  f.oauthQuery = page.search.slice(1);
  // A consent decision is taken only by a session that loaded the request (as the page does).
  for (const jar of Object.values(f.jars)) {
    await f.app.request(`/api/v1/oauth/consent?oauth_query=${encodeURIComponent(f.oauthQuery)}`, {
      headers: { cookie: jar.header() },
    });
  }
}

/** P9: a linked sign-in identity of the owner (stored in `f.identityId`). */
function addIdentity(f: Fixture, providerId: string): string {
  const id = uuidv7();
  f.db.orm
    .insert(account)
    .values({
      id,
      accountId: `${providerId}-${f.ownerId}`,
      providerId,
      userId: f.ownerId,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  f.identityId = id;
  return id;
}

/** A PAT that may write only in the owner's group B of the shared org. */
const writesInB = (f: Fixture): GrantConstraintsValue => ({
  orgs: [{ orgId: f.orgId, read: 'all', write: { groups: [f.otherGroupId] } }],
});
const invalidIdempotencyKey = { 'idempotency-key': 'not a key!' };

// --- Phase 10 (tasks): a recurring task and a reminder of the owner -------------------------
const p10 = new WeakMap<Fixture, { recurringId: string; reminderId: string; at: number }>();
function p10Setup(f: Fixture): void {
  const owner = f.actors.owner;
  const recurring = f.app.services.tasks.create(owner, f.orgId, {
    title: 'Weekly',
    groupId: f.groupId,
    dueDate: '2026-10-09',
    recurrence: 'FREQ=WEEKLY',
  });
  const at = Date.now() + 3_600_000;
  const { reminder } = f.app.services.reminders.create(owner, f.taskId, { at });
  p10.set(f, { recurringId: recurring.id, reminderId: reminder.id, at });
}
function p10Of(f: Fixture) {
  const ids = p10.get(f);
  if (ids === undefined) throw new Error('p10Setup did not run');
  return ids;
}
/** Distinct future instants for absolute reminders. */
const laterAt = (n: number) => Date.now() + (2 + n) * 3_600_000;

// --- Phase 10 (files): an image attachment, a member's avatar, a calendar feed ---------------
const files = new WeakMap<
  Fixture,
  { attachmentId: string; feedId: string; avatarUserId: string }
>();
/** A 1 × 1 PNG. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
function fileForm(content: Uint8Array | string, name: string, type: string): FormData {
  const form = new FormData();
  const data = typeof content === 'string' ? content : new Uint8Array(content);
  form.append('file', new File([data], name, { type }));
  return form;
}
const uploadOf = (form: FormData) => {
  const req = new Request(BASE_URL, { method: 'POST', body: form });
  return {
    contentType: req.headers.get('content-type') ?? undefined,
    contentLength: undefined,
    body: req.body,
  };
};
async function filesSetup(f: Fixture): Promise<void> {
  const s = f.app.services;
  const image = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#c33' } })
    .png()
    .toBuffer();
  const att = await s.attachments.upload(
    f.actors.owner,
    f.taskId,
    uploadOf(fileForm(image, 'photo.png', 'image/png')),
  );
  await s.avatars.put(f.actors.member, uploadOf(fileForm(PNG_1PX, 'me.png', 'image/png')));
  const feedId = s.icalFeeds.create(f.actors.owner, {}).feed.id;
  files.set(f, { attachmentId: att.id, feedId, avatarUserId: f.actors.member.userId });
}
function filesOf(f: Fixture) {
  const ids = files.get(f);
  if (ids === undefined) throw new Error('filesSetup did not run');
  return ids;
}
const attachmentPath = (f: Fixture, suffix = '') =>
  `/api/v1/attachments/${filesOf(f).attachmentId}${suffix}`;
const deleteOwnersTask = (f: Fixture) =>
  f.app.services.tasks.remove(f.actors.owner, f.taskId, {
    editTime: Date.now(),
    clientId: null,
    client: null,
  });

const SPECS: Record<string, Spec> = {
  // Phase 10 (files).
  'POST /api/v1/tasks/{id}/attachments': {
    ok: (f) => ({
      path: `/api/v1/tasks/${f.taskId}/attachments`,
      form: fileForm('notes', 'notes.txt', 'text/plain'),
    }),
    noGeneric: [413],
    cases: [
      {
        status: 409,
        code: 'too_many_attachments',
        setup: (f) => {
          for (let i = 0; i < 100; i++) {
            const id = fresh();
            f.db.orm
              .insert(attachment)
              .values({
                id,
                taskId: f.taskId,
                orgId: f.orgId,
                uploaderId: f.ownerId,
                filename: 'x.txt',
                mime: 'text/plain',
                size: 1,
                storage: 'local',
                key: `${f.orgId}/${id}`,
                createdAt: Date.now(),
              })
              .run();
          }
        },
      },
      {
        status: 410,
        code: 'conflict_deleted',
        request: (f) => ({
          path: `/api/v1/tasks/${f.trashedTaskId}/attachments`,
          form: fileForm('notes', 'notes.txt', 'text/plain'),
        }),
      },
      {
        status: 413,
        code: 'payload_too_large',
        fixture: { env: { ROOSTER_UPLOAD_MAX_MB: '1' } },
        request: (f) => ({
          path: `/api/v1/tasks/${f.taskId}/attachments`,
          form: fileForm(new Uint8Array(1024 * 1024 + 1), 'big.bin', 'application/octet-stream'),
        }),
      },
      {
        status: 415,
        code: 'mime_mismatch',
        request: (f) => ({
          path: `/api/v1/tasks/${f.taskId}/attachments`,
          form: fileForm('<html></html>', 'cat.png', 'image/png'),
        }),
      },
      {
        status: 422,
        name: 'no file part',
        code: 'validation_failed',
        request: (f) => ({ path: `/api/v1/tasks/${f.taskId}/attachments`, form: new FormData() }),
      },
    ],
  },
  'GET /api/v1/attachments/{id}': {
    setup: filesSetup,
    ok: (f) => ({ path: attachmentPath(f, '?inline=1') }),
  },
  'GET /api/v1/attachments/{id}/thumb': {
    setup: filesSetup,
    ok: (f) => ({ path: attachmentPath(f, '/thumb') }),
  },
  'DELETE /api/v1/attachments/{id}': {
    setup: filesSetup,
    ok: (f) => ({ path: attachmentPath(f) }),
    cases: [
      {
        status: 403,
        code: 'forbidden',
        request: (f) => ({ path: attachmentPath(f), as: 'member' }),
      },
      { status: 410, code: 'conflict_deleted', setup: deleteOwnersTask },
    ],
  },
  'PUT /api/v1/me/avatar': {
    ok: () => ({ path: '/api/v1/me/avatar', form: fileForm(PNG_1PX, 'me.png', 'image/png') }),
    noGeneric: [413],
    cases: [
      {
        status: 413,
        code: 'payload_too_large',
        request: () => ({
          path: '/api/v1/me/avatar',
          form: fileForm(new Uint8Array(2 * 1024 * 1024 + 1), 'big.png', 'image/png'),
        }),
      },
      {
        status: 415,
        code: 'mime_mismatch',
        request: () => ({ path: '/api/v1/me/avatar', form: fileForm('hi', 'me.png', 'image/png') }),
      },
      {
        status: 422,
        name: 'no file part',
        code: 'validation_failed',
        request: () => ({ path: '/api/v1/me/avatar', form: new FormData() }),
      },
    ],
  },
  'DELETE /api/v1/me/avatar': { setup: filesSetup, ok: () => ({ path: '/api/v1/me/avatar' }) },
  'GET /api/v1/avatars/{userId}': {
    setup: filesSetup,
    ok: (f) => ({ path: `/api/v1/avatars/${filesOf(f).avatarUserId}` }),
  },
  'GET /api/v1/me/ical-feeds': { setup: filesSetup, ok: () => ({ path: '/api/v1/me/ical-feeds' }) },
  'POST /api/v1/me/ical-feeds': {
    ok: () => ({ path: '/api/v1/me/ical-feeds', body: {} }),
    cases: [
      {
        status: 404,
        code: 'not_found',
        request: () => ({ path: '/api/v1/me/ical-feeds', body: { orgId: fresh() } }),
      },
      {
        status: 409,
        code: 'too_many_ical_feeds',
        setup: (f) => {
          for (let i = 0; i < 10; i++) f.app.services.icalFeeds.create(f.actors.owner, {});
        },
      },
    ],
  },
  'DELETE /api/v1/me/ical-feeds/{id}': {
    setup: filesSetup,
    ok: (f) => ({ path: `/api/v1/me/ical-feeds/${filesOf(f).feedId}` }),
  },
  // Phase 10 (tasks).
  'POST /api/v1/tasks/{id}/skip': {
    setup: p10Setup,
    ok: (f) => ({ path: `/api/v1/tasks/${p10Of(f).recurringId}/skip`, body: {} }),
    cases: [
      {
        status: 410,
        code: 'conflict_deleted',
        setup: (f) =>
          f.app.services.tasks.remove(f.actors.owner, p10Of(f).recurringId, {
            editTime: Date.now(),
            clientId: null,
            client: null,
          }),
      },
      {
        status: 409,
        code: 'id_conflict',
        request: (f) => ({
          path: `/api/v1/tasks/${p10Of(f).recurringId}/skip`,
          body: { nextId: f.taskId },
        }),
      },
      {
        status: 422,
        code: 'not_recurring',
        request: (f) => ({ path: `/api/v1/tasks/${f.taskId}/skip`, body: {} }),
      },
    ],
  },
  'GET /api/v1/tasks/{id}/reminders': {
    setup: p10Setup,
    ok: (f) => ({ path: `/api/v1/tasks/${f.taskId}/reminders` }),
  },
  'POST /api/v1/tasks/{id}/reminders': {
    setup: p10Setup,
    // The identical reminder: 200 with the existing one.
    ok: (f) => ({ path: `/api/v1/tasks/${f.taskId}/reminders`, body: { at: p10Of(f).at } }),
    cases: [
      {
        status: 201,
        name: 'a new reminder',
        request: (f) => ({ path: `/api/v1/tasks/${f.taskId}/reminders`, body: { at: laterAt(1) } }),
      },
      {
        status: 409,
        code: 'too_many_reminders',
        setup: (f) => {
          for (let n = 1; n <= 4; n += 1) {
            f.app.services.reminders.create(f.actors.owner, f.taskId, { at: laterAt(n) });
          }
        },
        request: (f) => ({ path: `/api/v1/tasks/${f.taskId}/reminders`, body: { at: laterAt(9) } }),
      },
      {
        status: 410,
        code: 'conflict_deleted',
        request: (f) => ({
          path: `/api/v1/tasks/${f.trashedTaskId}/reminders`,
          body: { at: laterAt(1) },
        }),
      },
    ],
  },
  'DELETE /api/v1/tasks/{id}/reminders/{reminderId}': {
    setup: p10Setup,
    ok: (f) => ({ path: `/api/v1/tasks/${f.taskId}/reminders/${p10Of(f).reminderId}` }),
  },
  'GET /api/v1/meta': { ok: () => ({ path: '/api/v1/meta' }) },
  'GET /api/v1/invites/{token}': {
    ok: (f) => ({ path: `/api/v1/invites/${f.inviteToken}` }),
    as: 'anonymous',
  },
  'POST /api/v1/invites/{token}/claim': {
    ok: (f) => ({ path: `/api/v1/invites/${f.inviteToken}/claim` }),
    as: 'anonymous',
    cases: [
      {
        status: 410,
        code: 'invite_invalid',
        setup: (f) => f.app.services.orgs.revokeInvite(f.actors.owner, f.orgId, f.inviteId),
      },
    ],
  },
  'POST /api/v1/invites/{token}/accept': {
    ok: (f) => ({ path: `/api/v1/invites/${f.inviteToken}/accept` }),
    as: 'nonMember',
    cases: [
      {
        status: 410,
        code: 'invite_invalid',
        setup: (f) => f.app.services.orgs.revokeInvite(f.actors.owner, f.orgId, f.inviteId),
      },
      {
        status: 403,
        code: 'invite_email_mismatch',
        request: (f) => {
          const { url } = f.app.services.orgs.createInvite(f.actors.owner, f.orgId, {
            email: 'someone-else@example.com',
            role: 'member',
          });
          return { path: `/api/v1/invites/${url.split('/invite/')[1]}/accept` };
        },
      },
    ],
  },
  'GET /api/v1/me': { ok: () => ({ path: '/api/v1/me' }) },
  'GET /api/v1/events': {
    ok: () => ({ path: '/api/v1/events' }),
    cases: [{ status: 503, code: 'unavailable', setup: (f) => void f.app.hub.shutdown() }],
  },
  'PATCH /api/v1/me': { ok: () => ({ path: '/api/v1/me', body: { name: 'Renamed' } }) },
  'GET /api/v1/me/sessions': { ok: () => ({ path: '/api/v1/me/sessions' }) },
  'DELETE /api/v1/me/sessions/{id}': {
    ok: (f) => ({ path: `/api/v1/me/sessions/${f.spareSessionId}` }),
  },
  'PUT /api/v1/me/org-order': {
    ok: (f) => ({ path: '/api/v1/me/org-order', body: { orgId: f.orgId } }),
    cases: [
      { status: 404, request: () => ({ path: '/api/v1/me/org-order', body: { orgId: fresh() } }) },
    ],
  },
  'PATCH /api/v1/me/orgs/{orgId}': {
    ok: (f) => ({ path: `/api/v1/me/orgs/${f.orgId}`, body: { collapsed: true } }),
  },
  'GET /api/v1/orgs': { ok: () => ({ path: '/api/v1/orgs' }) },
  'POST /api/v1/orgs': {
    ok: () => ({ path: '/api/v1/orgs', body: { name: 'New org' } }),
    cases: [
      {
        status: 409,
        code: 'slug_taken',
        request: (f) => ({ path: '/api/v1/orgs', body: { name: 'Clash', slug: f.orgSlug } }),
      },
    ],
  },
  'PATCH /api/v1/orgs/{orgId}': {
    ok: (f) => ({ path: `/api/v1/orgs/${f.orgId}`, body: { name: 'Renamed' } }),
    cases: [
      {
        status: 409,
        code: 'slug_taken',
        request: (f) => ({ path: `/api/v1/orgs/${f.orgId}`, body: { slug: f.otherOrgSlug } }),
      },
      {
        status: 409,
        code: 'personal_org',
        request: () => ({ path: '/api/v1/orgs/personal', body: { name: 'Mine' } }),
      },
      {
        status: 403,
        code: 'forbidden',
        request: (f) => ({ path: `/api/v1/orgs/${f.orgId}`, body: { name: 'X' }, as: 'member' }),
      },
    ],
  },
  'DELETE /api/v1/orgs/{orgId}': {
    ok: (f) => ({ path: `/api/v1/orgs/${f.orgId}`, body: { confirmName: 'Shared' } }),
    cases: [
      {
        status: 409,
        code: 'personal_org',
        request: () => ({ path: '/api/v1/orgs/personal', body: { confirmName: 'Personal' } }),
      },
      {
        status: 422,
        code: 'confirm_name_mismatch',
        request: (f) => ({ path: `/api/v1/orgs/${f.orgId}`, body: { confirmName: 'shared' } }),
      },
    ],
  },
  'GET /api/v1/orgs/{orgId}/members': {
    ok: (f) => ({ path: `/api/v1/orgs/${f.orgId}/members` }),
  },
  'PATCH /api/v1/orgs/{orgId}/members/{userId}': {
    ok: (f) => ({
      path: `/api/v1/orgs/${f.orgId}/members/${f.otherMemberId}`,
      body: { role: 'owner' },
    }),
    cases: [
      {
        status: 409,
        code: 'last_owner',
        request: (f) => ({
          path: `/api/v1/orgs/${f.orgId}/members/${f.ownerId}`,
          body: { role: 'member' },
        }),
      },
    ],
  },
  'DELETE /api/v1/orgs/{orgId}/members/{userId}': {
    ok: (f) => ({ path: `/api/v1/orgs/${f.orgId}/members/${f.otherMemberId}` }),
    cases: [
      {
        status: 409,
        code: 'last_owner',
        request: (f) => ({ path: `/api/v1/orgs/${f.orgId}/members/${f.ownerId}` }),
      },
    ],
  },
  'GET /api/v1/orgs/{orgId}/invites': {
    ok: (f) => ({ path: `/api/v1/orgs/${f.orgId}/invites` }),
    cases: [
      {
        status: 403,
        code: 'forbidden',
        request: (f) => ({ path: `/api/v1/orgs/${f.orgId}/invites`, as: 'member' }),
      },
    ],
  },
  'POST /api/v1/orgs/{orgId}/invites': {
    ok: (f) => ({ path: `/api/v1/orgs/${f.orgId}/invites`, body: { role: 'member' } }),
    cases: [
      {
        status: 409,
        code: 'personal_org',
        request: () => ({ path: '/api/v1/orgs/personal/invites', body: { role: 'member' } }),
      },
      {
        status: 409,
        code: 'already_member',
        request: (f) => ({
          path: `/api/v1/orgs/${f.orgId}/invites`,
          body: { email: 'member@example.com', role: 'member' },
        }),
      },
    ],
  },
  'DELETE /api/v1/orgs/{orgId}/invites/{id}': {
    ok: (f) => ({ path: `/api/v1/orgs/${f.orgId}/invites/${f.inviteId}` }),
  },
  'GET /api/v1/admin/allowlist': {
    ok: () => ({ path: '/api/v1/admin/allowlist' }),
    as: 'admin',
    cases: [{ status: 403, code: 'forbidden', request: () => adminAsMember('allowlist') }],
  },
  'POST /api/v1/admin/allowlist': {
    ok: () => ({ path: '/api/v1/admin/allowlist', body: { kind: 'domain', value: 'new.example' } }),
    as: 'admin',
    cases: [
      {
        status: 409,
        code: 'already_exists',
        request: () => ({
          path: '/api/v1/admin/allowlist',
          body: { kind: 'email', value: 'listed@example.com' },
        }),
      },
    ],
  },
  'DELETE /api/v1/admin/allowlist/{id}': {
    ok: (f) => ({ path: `/api/v1/admin/allowlist/${f.allowlistId}` }),
    as: 'admin',
  },
  'GET /api/v1/admin/users': {
    ok: () => ({ path: '/api/v1/admin/users' }),
    as: 'admin',
    cases: [{ status: 403, code: 'forbidden', request: () => adminAsMember('users') }],
  },
  'PATCH /api/v1/admin/users/{id}': {
    ok: (f) => ({ path: `/api/v1/admin/users/${f.otherMemberId}`, body: { disabled: true } }),
    as: 'admin',
    cases: [
      {
        status: 409,
        code: 'cannot_disable_self',
        request: (f) => ({ path: `/api/v1/admin/users/${f.adminId}`, body: { disabled: true } }),
      },
    ],
  },
  'GET /api/v1/admin/backups': {
    ok: () => ({ path: '/api/v1/admin/backups' }),
    as: 'admin',
    cases: [{ status: 403, code: 'forbidden', request: () => adminAsMember('backups') }],
  },
  'POST /api/v1/admin/backups': { ok: () => ({ path: '/api/v1/admin/backups' }), as: 'admin' },
  'GET /api/v1/admin/system': {
    ok: () => ({ path: '/api/v1/admin/system' }),
    as: 'admin',
    cases: [{ status: 403, code: 'forbidden', request: () => adminAsMember('system') }],
  },
  'GET /api/v1/admin/backups/{name}': {
    ok: (f) => ({ path: `/api/v1/admin/backups/${f.backupName}` }),
    as: 'admin',
    cases: [
      {
        status: 403,
        code: 'forbidden',
        request: (f) => ({ path: `/api/v1/admin/backups/${f.backupName}`, as: 'member' }),
      },
    ],
  },
  'POST /api/v1/admin/search/reindex': {
    ok: () => ({ path: '/api/v1/admin/search/reindex' }),
    as: 'admin',
  },
  'GET /api/v1/orgs/{orgId}/my-list': {
    ok: (f) => ({ path: `/api/v1/orgs/${f.orgId}/my-list` }),
    cases: [
      {
        status: 422,
        request: (f) => ({ path: `/api/v1/orgs/${f.orgId}/my-list?completedSince=-1` }),
      },
    ],
  },
  'POST /api/v1/orgs/{orgId}/groups': {
    ok: (f) => ({ path: `/api/v1/orgs/${f.orgId}/groups`, body: { name: 'New' } }),
    cases: [
      {
        status: 409,
        code: 'id_conflict',
        request: (f) => ({
          path: `/api/v1/orgs/${f.orgId}/groups`,
          body: { id: f.groupId, name: 'Other name' },
        }),
      },
      {
        status: 410,
        code: 'conflict_deleted',
        request: (f) => ({
          path: `/api/v1/orgs/${f.orgId}/groups`,
          body: { name: 'Split', splitAfterTaskId: f.trashedTaskId },
        }),
      },
    ],
  },
  'PATCH /api/v1/groups/{id}': {
    ok: (f) => ({ path: `/api/v1/groups/${f.groupId}`, body: { name: 'Renamed' } }),
    cases: [
      {
        status: 409,
        code: 'inbox_immutable',
        request: (f) => ({ path: `/api/v1/groups/${f.inboxId}`, body: { name: 'Renamed' } }),
      },
    ],
  },
  'POST /api/v1/groups/{id}/move': {
    ok: (f) => ({ path: `/api/v1/groups/${f.groupId}/move`, body: { afterId: null } }),
    cases: [
      {
        status: 409,
        code: 'inbox_immutable',
        request: (f) => ({ path: `/api/v1/groups/${f.inboxId}/move`, body: { afterId: null } }),
      },
    ],
  },
  'DELETE /api/v1/groups/{id}': {
    ok: (f) => ({ path: `/api/v1/groups/${f.groupId}`, body: { moveTasksTo: f.otherGroupId } }),
    cases: [
      {
        status: 409,
        code: 'group_not_empty',
        request: (f) => ({ path: `/api/v1/groups/${f.groupId}` }),
      },
      {
        status: 409,
        code: 'inbox_immutable',
        request: (f) => ({ path: `/api/v1/groups/${f.inboxId}` }),
      },
    ],
  },
  'POST /api/v1/groups/{id}/restore': {
    ok: (f) => ({ path: `/api/v1/groups/${f.deletedGroupId}/restore` }),
  },
  'GET /api/v1/orgs/{orgId}/tasks': {
    ok: (f) => ({ path: `/api/v1/orgs/${f.orgId}/tasks?view=today` }),
    cases: [
      {
        status: 200,
        name: 'everyone',
        request: (f) => ({ path: `/api/v1/orgs/${f.orgId}/tasks?view=everyone&tag=Tag` }),
      },
      { status: 422, request: (f) => ({ path: `/api/v1/orgs/${f.orgId}/tasks?limit=0` }) },
      {
        status: 409,
        code: 'personal_org',
        request: () => ({ path: '/api/v1/orgs/personal/tasks?view=everyone' }),
      },
    ],
  },
  'POST /api/v1/orgs/{orgId}/tasks': {
    ok: (f) => ({ path: `/api/v1/orgs/${f.orgId}/tasks`, body: { title: 'New task' } }),
    cases: [
      {
        status: 201,
        name: 'parse',
        request: (f) => ({
          path: `/api/v1/orgs/${f.orgId}/tasks`,
          body: { title: 'Pay invoice tomorrow >B', parse: true },
        }),
      },
      {
        status: 409,
        code: 'id_conflict',
        request: (f) => ({
          path: `/api/v1/orgs/${f.orgId}/tasks`,
          body: { id: f.taskId, title: 'Other title' },
        }),
      },
      {
        status: 410,
        code: 'conflict_deleted',
        request: (f) => ({
          path: `/api/v1/orgs/${f.orgId}/tasks`,
          body: { title: 'Child', parentId: f.trashedTaskId },
        }),
      },
      {
        status: 422,
        code: 'invalid_parent',
        request: (f) => ({
          path: `/api/v1/orgs/${f.orgId}/tasks`,
          body: { title: 'Child', parentId: f.personalTaskId },
        }),
      },
    ],
  },
  'PATCH /api/v1/tasks/{id}': {
    ok: (f) => ({ path: `/api/v1/tasks/${f.taskId}`, body: { title: 'Renamed' } }),
    cases: [
      {
        status: 409,
        code: 'too_many_reminders',
        setup: p10Setup,
        request: (f) => ({
          path: `/api/v1/tasks/${f.taskId}`,
          body: { reminders: [1, 2, 3, 4, 5].map((n) => ({ at: laterAt(n) })) },
        }),
      },
      {
        status: 200,
        name: 'stale edit',
        request: (f) => ({
          path: `/api/v1/tasks/${f.taskId}`,
          body: { title: 'Old' },
          headers: { 'x-rooster-edit-time': '1' },
        }),
      },
      {
        status: 410,
        code: 'conflict_deleted',
        request: (f) => ({ path: `/api/v1/tasks/${f.trashedTaskId}`, body: { title: 'X' } }),
      },
      {
        status: 422,
        code: 'subtask_cycle',
        request: (f) => ({ path: `/api/v1/tasks/${f.taskId}`, body: { parentId: f.subtaskId } }),
      },
    ],
  },
  'POST /api/v1/tasks/{id}/move': {
    ok: (f) => ({ path: `/api/v1/tasks/${f.taskId}/move`, body: { groupId: f.otherGroupId } }),
    cases: [
      {
        status: 410,
        code: 'conflict_deleted',
        request: (f) => ({
          path: `/api/v1/tasks/${f.trashedTaskId}/move`,
          body: { groupId: f.otherGroupId },
        }),
      },
    ],
  },
  'POST /api/v1/tasks/{id}/complete': {
    ok: (f) => ({ path: `/api/v1/tasks/${f.taskId}/complete`, body: { completed: true } }),
    cases: [
      {
        status: 409,
        code: 'id_conflict',
        setup: p10Setup,
        request: (f) => ({
          path: `/api/v1/tasks/${p10Of(f).recurringId}/complete`,
          body: { completed: true, nextId: f.taskId },
        }),
      },
      {
        status: 410,
        code: 'conflict_deleted',
        request: (f) => ({
          path: `/api/v1/tasks/${f.trashedTaskId}/complete`,
          body: { completed: true },
        }),
      },
      {
        status: 200,
        name: 'PAT inside its grant',
        setup: async (f) => {
          f.app.services.tasks.move(
            f.actors.owner,
            f.otherTaskId,
            { groupId: f.otherGroupId },
            { editTime: Date.now(), clientId: null, client: null },
          );
          f.bearer.b = (await mintPat(f, ['tasks:write'], writesInB(f))).token;
        },
        request: (f) => ({
          path: `/api/v1/tasks/${f.otherTaskId}/complete`,
          body: { completed: true },
          bearer: f.bearer.b,
        }),
      },
      {
        status: 403,
        code: 'outside_grant',
        setup: async (f) => {
          f.bearer.b = (await mintPat(f, ['tasks:write'], writesInB(f))).token;
        },
        request: (f) => ({
          path: `/api/v1/tasks/${f.taskId}/complete`,
          body: { completed: true },
          bearer: f.bearer.b,
        }),
      },
      {
        status: 403,
        code: 'forbidden_scope',
        setup: async (f) => {
          f.bearer.read = (await mintPat(f, ['tasks:read'])).token;
        },
        request: (f) => ({
          path: `/api/v1/tasks/${f.taskId}/complete`,
          body: { completed: true },
          bearer: f.bearer.read,
        }),
      },
    ],
  },
  'DELETE /api/v1/tasks/{id}': { ok: (f) => ({ path: `/api/v1/tasks/${f.taskId}` }) },
  'POST /api/v1/tasks/{id}/restore': {
    ok: (f) => ({ path: `/api/v1/tasks/${f.trashedTaskId}/restore` }),
  },
  'DELETE /api/v1/tasks/{id}/permanent': {
    ok: (f) => ({ path: `/api/v1/tasks/${f.trashedTaskId}/permanent` }),
    cases: [
      {
        status: 409,
        code: 'not_in_trash',
        request: (f) => ({ path: `/api/v1/tasks/${f.taskId}/permanent` }),
      },
    ],
  },
  'POST /api/v1/tasks/bulk': {
    ok: (f) => ({ path: '/api/v1/tasks/bulk', body: { op: 'complete', ids: [f.taskId, fresh()] } }),
  },
  'GET /api/v1/orgs/{orgId}/trash': {
    ok: (f) => ({ path: `/api/v1/orgs/${f.orgId}/trash` }),
    cases: [{ status: 422, request: (f) => ({ path: `/api/v1/orgs/${f.orgId}/trash?limit=0` }) }],
  },
  'GET /api/v1/tasks/{id}': { ok: (f) => ({ path: `/api/v1/tasks/${f.taskId}` }) },
  'POST /api/v1/tasks/{id}/reorder': {
    ok: (f) => ({ path: `/api/v1/tasks/${f.subtaskId}/reorder`, body: { afterId: null } }),
    cases: [
      {
        status: 409,
        code: 'not_subtask',
        request: (f) => ({ path: `/api/v1/tasks/${f.taskId}/reorder`, body: { afterId: null } }),
      },
      {
        status: 410,
        code: 'conflict_deleted',
        setup: (f) =>
          f.app.services.tasks.remove(f.actors.owner, f.subtaskId, {
            editTime: Date.now(),
            clientId: null,
            client: null,
          }),
        request: (f) => ({ path: `/api/v1/tasks/${f.subtaskId}/reorder`, body: { afterId: null } }),
      },
    ],
  },
  'POST /api/v1/tasks/{id}/duplicate': {
    ok: (f) => ({ path: `/api/v1/tasks/${f.taskId}/duplicate`, body: {} }),
    cases: [
      {
        status: 409,
        code: 'id_conflict',
        request: (f) => ({
          path: `/api/v1/tasks/${f.taskId}/duplicate`,
          body: { id: f.otherTaskId },
        }),
      },
      {
        status: 410,
        code: 'conflict_deleted',
        request: (f) => ({ path: `/api/v1/tasks/${f.trashedTaskId}/duplicate`, body: {} }),
      },
    ],
  },
  'PUT /api/v1/tasks/{id}/expanded': {
    ok: (f) => ({ path: `/api/v1/tasks/${f.taskId}/expanded` }),
    cases: [
      {
        status: 410,
        code: 'conflict_deleted',
        request: (f) => ({ path: `/api/v1/tasks/${f.trashedTaskId}/expanded` }),
      },
    ],
  },
  'DELETE /api/v1/tasks/{id}/expanded': {
    ok: (f) => ({ path: `/api/v1/tasks/${f.taskId}/expanded` }),
  },
  'PUT /api/v1/tasks/{id}/tags/{tagId}': {
    ok: (f) => ({ path: `/api/v1/tasks/${f.taskId}/tags/${f.otherTagId}` }),
    cases: [
      {
        status: 410,
        code: 'conflict_deleted',
        request: (f) => ({ path: `/api/v1/tasks/${f.trashedTaskId}/tags/${f.tagId}` }),
      },
    ],
  },
  'DELETE /api/v1/tasks/{id}/tags/{tagId}': {
    ok: (f) => ({ path: `/api/v1/tasks/${f.taskId}/tags/${f.tagId}` }),
    cases: [
      {
        status: 410,
        code: 'conflict_deleted',
        request: (f) => ({ path: `/api/v1/tasks/${f.trashedTaskId}/tags/${f.tagId}` }),
      },
    ],
  },
  'GET /api/v1/orgs/{orgId}/tags': { ok: (f) => ({ path: `/api/v1/orgs/${f.orgId}/tags` }) },
  'POST /api/v1/orgs/{orgId}/tags': {
    ok: (f) => ({ path: `/api/v1/orgs/${f.orgId}/tags`, body: { name: 'New tag' } }),
    cases: [
      {
        status: 409,
        code: 'tag_name_taken',
        request: (f) => ({ path: `/api/v1/orgs/${f.orgId}/tags`, body: { name: 'tag' } }),
      },
      {
        status: 409,
        code: 'id_conflict',
        request: (f) => ({
          path: `/api/v1/orgs/${f.orgId}/tags`,
          body: { id: f.tagId, name: 'Unrelated' },
        }),
      },
    ],
  },
  'PATCH /api/v1/tags/{id}': {
    ok: (f) => ({ path: `/api/v1/tags/${f.tagId}`, body: { name: 'Renamed' } }),
    cases: [
      {
        status: 409,
        code: 'tag_name_taken',
        request: (f) => ({ path: `/api/v1/tags/${f.tagId}`, body: { name: 'Other tag' } }),
      },
    ],
  },
  'DELETE /api/v1/tags/{id}': { ok: (f) => ({ path: `/api/v1/tags/${f.tagId}` }) },
  'POST /api/v1/tags/{id}/merge': {
    ok: (f) => ({ path: `/api/v1/tags/${f.tagId}/merge`, body: { intoId: f.otherTagId } }),
  },
  'GET /api/v1/search': {
    ok: (f) => ({ path: `/api/v1/search?q=task&orgId=${f.orgId}` }),
    cases: [
      { status: 404, request: () => ({ path: `/api/v1/search?q=task&orgId=${fresh()}` }) },
      { status: 422, request: () => ({ path: '/api/v1/search' }) },
    ],
  },
  'GET /api/v1/orgs/{orgId}/export': {
    ok: (f) => ({ path: `/api/v1/orgs/${f.orgId}/export?format=json` }),
    cases: [
      {
        status: 200,
        name: 'markdown',
        request: (f) => ({ path: `/api/v1/orgs/${f.orgId}/export?format=markdown` }),
      },
      { status: 422, request: (f) => ({ path: `/api/v1/orgs/${f.orgId}/export?format=xml` }) },
    ],
  },
  'GET /api/v1/tasks/{id}/activity': {
    ok: (f) => ({ path: `/api/v1/tasks/${f.taskId}/activity` }),
    cases: [
      { status: 422, request: (f) => ({ path: `/api/v1/tasks/${f.taskId}/activity?limit=0` }) },
    ],
  },
  'POST /api/v1/tasks/{id}/comments': {
    ok: (f) => ({ path: `/api/v1/tasks/${f.taskId}/comments`, body: { body: 'Hi' } }),
    cases: [
      {
        status: 409,
        code: 'id_conflict',
        request: (f) => ({
          path: `/api/v1/tasks/${f.taskId}/comments`,
          body: { id: f.commentId, body: 'Another body' },
        }),
      },
      {
        status: 410,
        code: 'conflict_deleted',
        request: (f) => ({
          path: `/api/v1/tasks/${f.trashedTaskId}/comments`,
          body: { body: 'Hi' },
        }),
      },
    ],
  },
  'PATCH /api/v1/comments/{id}': {
    ok: (f) => ({ path: `/api/v1/comments/${f.commentId}`, body: { body: 'Edited' } }),
    cases: [
      {
        status: 410,
        code: 'conflict_deleted',
        request: (f) => ({ path: `/api/v1/comments/${f.deletedCommentId}`, body: { body: 'X' } }),
      },
      {
        status: 403,
        code: 'forbidden',
        request: (f) => ({
          path: `/api/v1/comments/${f.commentId}`,
          body: { body: 'Mine now' },
          as: 'member',
        }),
      },
    ],
  },
  'DELETE /api/v1/comments/{id}': {
    ok: (f) => ({ path: `/api/v1/comments/${f.commentId}` }),
    cases: [
      {
        status: 410,
        code: 'conflict_deleted',
        request: (f) => ({ path: `/api/v1/comments/${f.trashedTaskCommentId}` }),
      },
    ],
  },
  'POST /api/v1/comments/{id}/restore': {
    ok: (f) => ({ path: `/api/v1/comments/${f.deletedCommentId}/restore` }),
    cases: [
      {
        status: 410,
        code: 'conflict_deleted',
        request: (f) => ({ path: `/api/v1/comments/${f.trashedTaskCommentId}/restore` }),
      },
    ],
  },
  'PUT /api/v1/tasks/{id}/followers/me': {
    ok: (f) => ({ path: `/api/v1/tasks/${f.taskId}/followers/me` }),
    cases: [
      {
        status: 409,
        code: 'personal_org',
        request: (f) => ({ path: `/api/v1/tasks/${f.personalTaskId}/followers/me` }),
      },
      {
        status: 410,
        code: 'conflict_deleted',
        request: (f) => ({ path: `/api/v1/tasks/${f.trashedTaskId}/followers/me` }),
      },
    ],
  },
  'DELETE /api/v1/tasks/{id}/followers/me': {
    ok: (f) => ({ path: `/api/v1/tasks/${f.taskId}/followers/me` }),
    cases: [
      {
        status: 409,
        code: 'personal_org',
        request: (f) => ({ path: `/api/v1/tasks/${f.personalTaskId}/followers/me` }),
      },
      {
        status: 410,
        code: 'conflict_deleted',
        request: (f) => ({ path: `/api/v1/tasks/${f.trashedTaskId}/followers/me` }),
      },
    ],
  },
  'GET /api/v1/notifications': {
    ok: () => ({ path: '/api/v1/notifications' }),
    as: 'member',
    setup: (f) => {
      f.app.services.comments.create(f.actors.owner, f.taskId, {
        body: `Ping @[Member](user:${f.actors.member.userId})`,
      });
    },
    cases: [{ status: 422, request: () => ({ path: '/api/v1/notifications?unread=maybe' }) }],
  },
  'POST /api/v1/notifications/read': {
    ok: () => ({ path: '/api/v1/notifications/read', body: { all: true } }),
  },
  'POST /api/v1/notifications/unread': {
    ok: () => ({ path: '/api/v1/notifications/unread', body: { all: true } }),
  },
  'GET /api/v1/me/notification-prefs': { ok: () => ({ path: '/api/v1/me/notification-prefs' }) },
  'PUT /api/v1/me/notification-prefs': {
    ok: () => ({
      path: '/api/v1/me/notification-prefs',
      body: { prefs: [{ type: 'comment', channel: 'inapp', enabled: false }] },
    }),
  },
  // WP 8.2: Connected apps, PATs, CLI devices and task refs.
  'GET /api/v1/me/grants': {
    ok: () => ({ path: '/api/v1/me/grants' }),
    setup: async (f) => {
      f.bearer.read = (await mintPat(f, ['tasks:read'])).token;
    },
    cases: [
      {
        status: 200,
        name: 'as a PAT',
        request: (f) => ({ path: '/api/v1/me/grants', bearer: f.bearer.read }),
      },
    ],
  },
  'PATCH /api/v1/me/grants/{id}': {
    ok: (f) => ({ path: `/api/v1/me/grants/${f.grantId}`, body: { label: 'Renamed' } }),
    setup: async (f) => {
      const minted = await mintPat(f, ['tasks:read']);
      f.grantId = minted.grant.id;
      f.bearer.read = minted.token;
    },
    cases: [
      {
        status: 403,
        code: 'forbidden_scope',
        request: (f) => ({
          path: `/api/v1/me/grants/${f.grantId}`,
          body: { scopes: ['tasks:write'] },
          bearer: f.bearer.read,
        }),
      },
      {
        status: 403,
        code: 'admin_only_scope',
        request: (f) => ({
          path: `/api/v1/me/grants/${f.grantId}`,
          body: { scopes: ['tasks:read', 'admin'] },
        }),
      },
    ],
  },
  'DELETE /api/v1/me/grants/{id}': {
    ok: (f) => ({ path: `/api/v1/me/grants/${f.grantId}` }),
    setup: async (f) => {
      const minted = await mintPat(f, ['tasks:read']);
      f.grantId = minted.grant.id;
      f.bearer.read = minted.token;
      f.bearer.other = (await mintPat(f, ['tasks:read'])).token;
    },
    cases: [
      {
        status: 204,
        name: 'a PAT revokes itself',
        request: (f) => ({ path: `/api/v1/me/grants/${f.grantId}`, bearer: f.bearer.read }),
      },
      {
        status: 403,
        code: 'forbidden_scope',
        request: (f) => ({ path: `/api/v1/me/grants/${f.grantId}`, bearer: f.bearer.other }),
      },
    ],
  },
  'POST /api/v1/me/tokens': {
    ok: () => ({
      path: '/api/v1/me/tokens',
      body: { name: 'Script', scopes: ['tasks:read'], constraints: { orgs: 'all' } },
    }),
    cases: [
      {
        status: 403,
        code: 'admin_only_scope',
        request: () => ({
          path: '/api/v1/me/tokens',
          body: { name: 'Script', scopes: ['admin'], constraints: { orgs: 'all' } },
        }),
      },
      {
        status: 403,
        code: 'forbidden_scope',
        setup: async (f) => {
          f.bearer.read = (await mintPat(f, ['tasks:read'])).token;
        },
        request: (f) => ({
          path: '/api/v1/me/tokens',
          body: { name: 'Script', scopes: ['tasks:read'], constraints: { orgs: 'all' } },
          bearer: f.bearer.read,
        }),
      },
      {
        status: 201,
        name: 'a device session, within its grant',
        setup: async (f) => {
          f.bearer.device = await deviceSession(f, {
            scopes: ['tasks:read', 'tasks:write'],
            constraints: { orgs: 'all' },
          });
        },
        request: (f) => ({
          path: '/api/v1/me/tokens',
          body: { name: 'Script', scopes: ['tasks:read'], constraints: writesInB(f) },
          bearer: f.bearer.device,
        }),
      },
      {
        status: 422,
        code: 'widening_not_allowed',
        setup: async (f) => {
          f.bearer.device = await deviceSession(f, {
            scopes: ['tasks:read'],
            constraints: { orgs: 'all' },
          });
        },
        request: (f) => ({
          path: '/api/v1/me/tokens',
          body: { name: 'Script', scopes: ['tasks:delete'], constraints: { orgs: 'all' } },
          bearer: f.bearer.device,
        }),
      },
    ],
  },
  'GET /api/v1/device/{userCode}': {
    ok: (f) => ({ path: `/api/v1/device/${f.userCode}` }),
    setup: async (f) => {
      await startDevice(f);
    },
  },
  'POST /api/v1/device/{userCode}/approve': {
    ok: (f) => ({
      path: `/api/v1/device/${f.userCode}/approve`,
      body: { scopes: ['tasks:read'], constraints: { orgs: 'all' } },
    }),
    setup: async (f) => {
      await startDevice(f, 'tasks:read tasks:write');
    },
    cases: [
      {
        status: 422,
        code: 'widening_not_allowed',
        request: (f) => ({
          path: `/api/v1/device/${f.userCode}/approve`,
          body: { scopes: ['tasks:delete'], constraints: { orgs: 'all' } },
        }),
      },
    ],
  },
  'POST /api/v1/device/{userCode}/deny': {
    ok: (f) => ({ path: `/api/v1/device/${f.userCode}/deny` }),
    setup: async (f) => {
      await startDevice(f);
    },
  },
  // P9 (ADR 0042): the OAuth consent screen and linked identities.
  'GET /api/v1/oauth/consent': {
    ok: (f) => ({ path: `/api/v1/oauth/consent?oauth_query=${encodeURIComponent(f.oauthQuery)}` }),
    setup: startConsent,
    cases: [
      {
        status: 404,
        name: 'a tampered query',
        code: 'not_found',
        request: (f) => ({
          path: `/api/v1/oauth/consent?oauth_query=${encodeURIComponent(`${f.oauthQuery}&scope=tasks%3Adelete`)}`,
        }),
      },
    ],
  },
  'POST /api/v1/oauth/consent': {
    ok: (f) => ({
      path: '/api/v1/oauth/consent',
      body: {
        accept: true,
        oauthQuery: f.oauthQuery,
        scopes: ['tasks:read'],
        constraints: { orgs: 'all' },
        sessionOnly: true,
      },
    }),
    setup: startConsent,
    cases: [
      {
        status: 200,
        name: 'deny',
        request: (f) => ({
          path: '/api/v1/oauth/consent',
          body: { accept: false, oauthQuery: f.oauthQuery },
        }),
      },
      {
        status: 404,
        name: 'an unsigned query',
        code: 'not_found',
        request: () => ({
          path: '/api/v1/oauth/consent',
          body: { accept: false, oauthQuery: 'client_id=contract-app&sig=x' },
        }),
      },
    ],
  },
  'GET /api/v1/me/identities': {
    ok: () => ({ path: '/api/v1/me/identities' }),
    setup: (f) => {
      addIdentity(f, 'google');
    },
  },
  'DELETE /api/v1/me/identities/{id}': {
    ok: (f) => ({ path: `/api/v1/me/identities/${f.identityId}` }),
    setup: (f) => {
      addIdentity(f, 'google');
      addIdentity(f, 'dev');
    },
    cases: [
      {
        status: 409,
        code: 'last_identity',
        setup: (f) => {
          f.app.services.identities.unlink(f.actors.owner, f.identityId);
          f.identityId = f.app.services.identities.list(f.actors.owner)[0]?.id ?? f.identityId;
        },
      },
    ],
  },
  'GET /api/v1/tasks/resolve': {
    ok: (f) => ({ path: `/api/v1/tasks/resolve?ref=${f.taskSeq}&org=${f.orgId}` }),
    cases: [
      {
        status: 200,
        name: 'org#number',
        request: (f) => ({ path: `/api/v1/tasks/resolve?ref=${f.orgSlug}%23${f.taskSeq}` }),
      },
      {
        status: 404,
        code: 'not_found',
        request: (f) => ({ path: `/api/v1/tasks/resolve?ref=4242&org=${f.orgId}` }),
      },
      { status: 422, request: () => ({ path: '/api/v1/tasks/resolve' }) },
      {
        status: 409,
        code: 'ambiguous_ref',
        // Tasks created within the same ~65 s share their first 8 hex digits (UUIDv7 time).
        request: (f) => ({ path: `/api/v1/tasks/resolve?ref=${f.taskId.slice(0, 8)}` }),
      },
    ],
  },
  'GET /api/v1/push/vapid-public-key': { ok: () => ({ path: '/api/v1/push/vapid-public-key' }) },
  'GET /api/v1/me/push-subscriptions': { ok: () => ({ path: '/api/v1/me/push-subscriptions' }) },
  'POST /api/v1/me/push-subscriptions': {
    ok: () => ({ path: '/api/v1/me/push-subscriptions', body: subscriptionBody('laptop') }),
  },
  'DELETE /api/v1/me/push-subscriptions/{id}': {
    ok: (f) => ({ path: `/api/v1/me/push-subscriptions/${f.pushSubscriptionId}` }),
  },
  'POST /api/v1/me/push-subscriptions/{id}/test': {
    ok: (f) => ({ path: `/api/v1/me/push-subscriptions/${f.pushSubscriptionId}/test` }),
    cases: [
      {
        status: 410,
        code: 'push_gone',
        setup: (f) => void f.push.failWith.set(fcmEndpoint('owner'), 410),
      },
      {
        status: 502,
        code: 'push_failed',
        setup: (f) => void f.push.failWith.set(fcmEndpoint('owner'), 500),
      },
    ],
  },
  'POST /api/v1/admin/push-keys/regenerate': {
    ok: () => ({ path: '/api/v1/admin/push-keys/regenerate' }),
    as: 'admin',
    cases: [
      {
        status: 409,
        code: 'push_keys_from_env',
        fixture: {
          env: {
            ROOSTER_VAPID_PUBLIC:
              'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
            ROOSTER_VAPID_PRIVATE: 'tUxbf-Mx9Ex4QgiRbWvt-Q1j0yAfGfgFFUFvcNt7ZnU',
          },
        },
      },
    ],
  },
};

function adminAsMember(resource: string): Req {
  return { path: `/api/v1/admin/${resource}`, as: 'member' };
}

// --- the OpenAPI document ------------------------------------------------------------------

type Json = Record<string, unknown>;
interface DocResponse {
  description: string;
  headers?: Record<string, Json>;
  content?: Record<string, { schema?: Json; examples?: Record<string, unknown> }>;
}
interface DocOperation {
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  requestBody?: { content?: Record<string, { schema?: Json }> };
  responses: Record<string, DocResponse>;
}
interface Doc {
  paths: Record<string, Record<string, DocOperation>>;
  tags: { name: string; description?: string }[];
  components: { schemas: Record<string, Json>; headers: Record<string, Json> };
}

const { app: docApp } = createTestApp();
const doc = (await (await docApp.request('/api/v1/openapi.json')).json()) as Doc;
const contracts = routeContracts(docApp);
const documented = Object.entries(doc.paths).flatMap(([path, ops]) =>
  Object.entries(ops).map(([method, op]) => ({
    route: `${method.toUpperCase()} ${path}`,
    method,
    path,
    op,
  })),
);
const operations = documented;

function contractOf(route: string): RouteContract {
  const contract = contracts.find((c) => `${c.method} ${c.path}` === route);
  if (contract === undefined) throw new Error(`no contract for ${route}`);
  return contract;
}

function codesOf(route: string, status: number): string[] {
  const [method = '', path = ''] = route.split(' ');
  const response = doc.paths[path]?.[method.toLowerCase()]?.responses[String(status)];
  return Object.keys(response?.content?.['application/problem+json']?.examples ?? {});
}

function requiredHeaders(route: string, status: number): string[] {
  const [method = '', path = ''] = route.split(' ');
  const response = doc.paths[path]?.[method.toLowerCase()]?.responses[String(status)];
  return Object.entries(response?.headers ?? {})
    .filter(([, header]) => {
      const ref = header.$ref as string | undefined;
      const resolved =
        ref === undefined ? header : doc.components.headers[ref.split('/').pop() ?? ''];
      return resolved?.required === true;
    })
    .map(([name]) => name);
}

// --- fixture and requests ------------------------------------------------------------------

const dataDirs: (() => void)[] = [];
afterAll(() => {
  for (const cleanup of dataDirs) cleanup();
});

function actorFor(app: App, userId: string, sessionId: string): Actor {
  const actor = app.services.users.resolveActor(userId, sessionId);
  if (actor === null) throw new Error('fixture actor');
  return actor;
}

/** The shared org "Shared" of the owner, with a member, another member and everything in it. */
function fixture(options: FixtureOptions = {}): Fixture {
  const dataDir = tempDir();
  dataDirs.push(dataDir.cleanup);
  const { app, db, push } = createTestApp({
    env: { ROOSTER_DATA_DIR: dataDir.path, ...options.env },
    apiRateLimit: options.rateLimited ? { max: 0, windowMs: 60_000 } : false,
  });
  const make = (email: string) => createUserWithSession(app, db, { email });
  const owner = make('owner@example.com');
  const member = make('member@example.com');
  const other = make('other@example.com');
  const nonMember = make('outsider@example.com');
  const admin = make('admin@example.com');
  const spareSessionId = addSession(
    db,
    owner.userId,
    new CookieJar(),
    TEST_ENV.ROOSTER_AUTH_SECRET,
  );

  const s = app.services;
  const ownerActor = actorFor(app, owner.userId, owner.sessionId);
  const adminActor = actorFor(app, admin.userId, admin.sessionId);
  const org = s.orgs.create(ownerActor, { name: 'Shared' });
  const otherOrg = s.orgs.create(ownerActor, { name: 'Elsewhere' });
  for (const u of [member, other]) {
    const { url } = s.orgs.createInvite(ownerActor, org.id, { role: 'member' });
    s.orgs.acceptInvite(actorFor(app, u.userId, u.sessionId), url.split('/invite/')[1] ?? '');
  }
  const link = s.orgs.createInvite(ownerActor, org.id, { role: 'member', multiUse: true });
  const entry = s.admin.addAllowlist(adminActor, { kind: 'email', value: 'listed@example.com' });
  const backup = s.backups.createManual(adminActor);
  const subscription = s.push.subscribe(ownerActor, subscriptionBody('owner'), null);

  const meta = { editTime: Date.now(), clientId: null, client: null };
  const groupA = s.groups.create(ownerActor, org.id, { name: 'A' }).group.id;
  const groupB = s.groups.create(ownerActor, org.id, { name: 'B' }).group.id;
  const deleted = s.groups.create(ownerActor, org.id, { name: 'Gone' }).group.id;
  s.groups.remove(ownerActor, deleted, {}, meta);
  const inbox = s.tasks.myList(ownerActor, org.id).groups.find((g) => g.kind === 'inbox');
  if (inbox === undefined) throw new Error('fixture inbox');
  const task = s.tasks.create(ownerActor, org.id, { title: 'Task', groupId: groupA });
  const otherTask = s.tasks.create(ownerActor, org.id, { title: 'Other task', groupId: groupA });
  const trashed = s.tasks.create(ownerActor, org.id, { title: 'Trashed' });
  const trashedComment = s.comments.create(ownerActor, trashed.id, { body: 'Before delete' });
  s.tasks.remove(ownerActor, trashed.id, meta);
  const personal = s.tasks.create(ownerActor, 'personal', { title: 'Private' });
  const tag = s.tags.create(ownerActor, org.id, { name: 'Tag' });
  const otherTag = s.tags.create(ownerActor, org.id, { name: 'Other tag' });
  s.tags.setOnTask(ownerActor, task.id, tag.id, true);
  const subtask = s.tasks.create(ownerActor, org.id, { title: 'Subtask', parentId: task.id });
  s.tasks.create(ownerActor, org.id, { title: 'Sibling', parentId: task.id });
  const comment = s.comments.create(ownerActor, task.id, { body: 'Comment' });
  const deletedComment = s.comments.create(ownerActor, task.id, { body: 'Deleted' });
  s.comments.remove(ownerActor, deletedComment.id);

  return {
    app,
    push,
    orgId: org.id,
    orgSlug: org.slug,
    otherOrgSlug: otherOrg.slug,
    ownerId: owner.userId,
    adminId: admin.userId,
    otherMemberId: other.userId,
    spareSessionId,
    inviteId: link.id,
    inviteToken: link.url.split('/invite/')[1] ?? '',
    allowlistId: entry.id,
    inboxId: inbox.id,
    groupId: groupA,
    otherGroupId: groupB,
    deletedGroupId: deleted,
    taskId: task.id,
    otherTaskId: otherTask.id,
    trashedTaskId: trashed.id,
    personalTaskId: personal.id,
    subtaskId: subtask.id,
    tagId: tag.id,
    otherTagId: otherTag.id,
    commentId: comment.id,
    deletedCommentId: deletedComment.id,
    trashedTaskCommentId: trashedComment.id,
    db,
    backupName: backup.name,
    pushSubscriptionId: subscription.id,
    jars: {
      owner: owner.jar,
      member: member.jar,
      nonMember: nonMember.jar,
      admin: admin.jar,
    },
    actors: {
      owner: ownerActor,
      admin: adminActor,
      member: actorFor(app, member.userId, member.sessionId),
    },
    taskSeq: task.seq ?? 0,
    bearer: {},
    userCode: '',
    grantId: '',
    oauthQuery: '',
    identityId: '',
  };
}

async function send(f: Fixture, method: string, req: Req, actor: ActorKind): Promise<Response> {
  const headers = new Headers();
  const as = req.as ?? actor;
  if (req.bearer !== undefined) headers.set('authorization', `Bearer ${req.bearer}`);
  else {
    headers.set('origin', BASE_URL);
    if (as !== 'anonymous') headers.set('cookie', f.jars[as].header());
  }
  let body: string | FormData | undefined;
  if (req.form !== undefined) body = req.form;
  else if (req.rawBody !== undefined) body = req.rawBody;
  else if (req.body !== undefined) {
    body = JSON.stringify(req.body);
    headers.set('content-type', 'application/json');
  }
  for (const [name, value] of Object.entries(req.headers ?? {})) headers.set(name, value);
  return f.app.request(req.path, { method, headers, ...(body === undefined ? {} : { body }) });
}

// --- cases ---------------------------------------------------------------------------------

const SAFE = new Set(['GET', 'HEAD']);
const OVERSIZED = `{"x":"${'a'.repeat(1024 * 1024)}"}`;

/** Every path parameter replaced by an unknown ID. */
function unknownPath(template: string, concrete: string): string {
  const query = concrete.includes('?') ? concrete.slice(concrete.indexOf('?')) : '';
  return template.replace(/\{[^}]+\}/g, () => fresh()) + query;
}

/** A case for an error status that every route of its kind reaches the same way. */
function genericCase(route: string, spec: Spec, status: number): Case | string {
  const [method = '', template = ''] = route.split(' ');
  const unsafe = !SAFE.has(method);
  const ok = spec.ok;
  const name = 'generic';
  switch (status) {
    case 401:
      return {
        name,
        status,
        request: (f) => ({ ...ok(f), as: 'anonymous' }),
        code: 'unauthenticated',
      };
    case 403: {
      if (unsafe) {
        const request = (f: Fixture) => ({ ...ok(f), headers: { origin: 'https://evil.example' } });
        return { name, status, request, code: 'csrf_origin' };
      }
      // A PAT without the capability the route reads with: notifications need
      // `notifications:read`, everything else `tasks:read` (browser-only routes refuse any).
      const scopes: GrantScope[] =
        route === 'GET /api/v1/notifications' ? ['tasks:read'] : ['notifications:read'];
      return {
        name: 'generic (PAT)',
        status,
        setup: async (f) => {
          f.bearer.generic = (await mintPat(f, scopes)).token;
        },
        request: (f) => ({ ...ok(f), bearer: f.bearer.generic }),
      };
    }
    case 404:
      if (!template.includes('{')) return `${route}: 404 without a path parameter needs a case`;
      return {
        name,
        status,
        request: (f) => ({ ...ok(f), path: unknownPath(template, ok(f).path) }),
        code: 'not_found',
      };
    case 413:
      return {
        name,
        status,
        request: (f) => ({ ...ok(f), rawBody: OVERSIZED }),
        code: 'payload_too_large',
      };
    case 415:
      return {
        name,
        status,
        request: (f) => ({ ...ok(f), rawBody: 'x', headers: { 'content-type': 'text/plain' } }),
        code: 'unsupported_media_type',
      };
    case 422:
      if (!unsafe) return `${route}: 422 on a GET route needs a case with an invalid query`;
      return {
        name,
        status,
        request: (f) => ({ ...ok(f), headers: invalidIdempotencyKey }),
        code: 'validation_failed',
      };
    case 429:
      return { name, status, request: ok, fixture: { rateLimited: true }, code: 'rate_limited' };
    default:
      return `${route}: ${status} needs a case`;
  }
}

function casesFor(route: string, spec: Spec): { cases: Case[]; missing: string[] } {
  const contract = contractOf(route);
  const declared = [...contract.responses.keys()];
  const success = declared.find((s) => s < 300);
  if (success === undefined) throw new Error(`${route} declares no success`);
  const specific: Case[] = (spec.cases ?? []).map((c) => ({
    name: c.name ?? c.code ?? 'specific',
    status: c.status,
    request: c.request ?? spec.ok,
    ...(c.setup === undefined ? {} : { setup: c.setup }),
    ...(c.code === undefined ? {} : { code: c.code }),
    ...(c.fixture === undefined ? {} : { fixture: c.fixture }),
  }));
  const cases: Case[] = [{ name: 'happy path', status: success, request: spec.ok }, ...specific];
  const missing: string[] = [];
  for (const status of declared.filter((s) => s >= 400)) {
    const generic = spec.noGeneric?.includes(status)
      ? `${route}: ${status} needs a case`
      : genericCase(route, spec, status);
    if (typeof generic !== 'string') cases.push(generic);
    else if (!specific.some((c) => c.status === status)) missing.push(generic);
  }
  return { cases, missing };
}

describe('API contract (10 §3)', () => {
  it('has a spec for every route in the OpenAPI document, and no stale specs', () => {
    const routes = operations.map((o) => o.route).filter((r) => r.includes(' /api/v1/'));
    expect(routes.filter((r) => !(r in SPECS))).toEqual([]);
    expect(Object.keys(SPECS).filter((r) => !routes.includes(r))).toEqual([]);
  });

  it('has a case for every documented status of every route', () => {
    const missing = Object.entries(SPECS)
      .filter(([route]) => operations.some((o) => o.route === route))
      .flatMap(([route, spec]) => casesFor(route, spec).missing);
    expect(missing).toEqual([]);
  });

  const all = Object.entries(SPECS)
    .filter(([route]) => operations.some((o) => o.route === route))
    .flatMap(([route, spec]) =>
      casesFor(route, spec).cases.map((c) => ({ route, spec, c, label: `${c.status} ${c.name}` })),
    );

  it.each(all)('$route → $label', async ({ route, spec, c }) => {
    const [method = 'GET'] = route.split(' ');
    const f = fixture({ ...spec.fixture, ...c.fixture });
    await spec.setup?.(f);
    await c.setup?.(f);
    const req = c.request(f);
    const res = await send(f, method, req, spec.as ?? 'owner');
    const text = res.headers.get('content-type')?.startsWith('text/event-stream')
      ? '(stream)'
      : await res.clone().text();
    expect(res.status, `${req.path}: ${text.slice(0, 500)}`).toBe(c.status);

    const violation = await checkResponse(contractOf(route), { method, path: req.path }, res, 0);
    expect(violation, JSON.stringify(violation)).toBeNull();
    for (const header of requiredHeaders(route, res.status)) {
      expect(res.headers.has(header), `${header} header`).toBe(true);
    }
    if (res.status >= 400) {
      const { code } = JSON.parse(text) as { code: string };
      expect(codesOf(route, res.status), `${code} is documented`).toContain(code);
      if (c.code !== undefined) expect(code).toBe(c.code);
    }
    await res.body?.cancel();
  });

  it('replays an idempotent mutation with Idempotent-Replayed and the stored body', async () => {
    const f = fixture();
    const route = 'POST /api/v1/orgs/{orgId}/tasks';
    const req = {
      path: `/api/v1/orgs/${f.orgId}/tasks`,
      body: { title: 'Once' },
      headers: { 'idempotency-key': fresh() },
    };
    const first = await send(f, 'POST', req, 'owner');
    const replay = await send(f, 'POST', req, 'owner');
    expect(replay.status).toBe(201);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(
      await checkResponse(contractOf(route), { method: 'POST', path: req.path }, replay, 0),
    ).toBeNull();
    expect(await replay.json()).toEqual(await first.json());
  });
});

// --- the document --------------------------------------------------------------------------

/** True when the schema, or what it references, carries an example. */
function hasExample(schema: Json | undefined): boolean {
  if (schema === undefined) return false;
  if ('example' in schema || 'examples' in schema) return true;
  const ref = schema.$ref as string | undefined;
  if (ref !== undefined) return hasExample(doc.components.schemas[ref.split('/').pop() ?? '']);
  if (schema.type === 'array') return hasExample(schema.items as Json | undefined);
  return false;
}

describe('OpenAPI document (WP 8.1)', () => {
  it.each(operations)('$route is described', ({ op }) => {
    expect(op.summary).toBeTruthy();
    expect(op.description).toBeTruthy();
    expect(op.operationId).toBeTruthy();
    expect(op.tags).toHaveLength(1);
    for (const [status, response] of Object.entries(op.responses)) {
      expect(response.description, status).toBeTruthy();
      const problem = response.content?.['application/problem+json'];
      if (problem !== undefined) {
        expect(Object.keys(problem.examples ?? {}), `${status} lists its codes`).not.toEqual([]);
      }
    }
  });

  it.each(operations.filter(({ path }) => path.startsWith('/api/v1/')))(
    '$route has request and response examples',
    ({ op }) => {
      const request = op.requestBody?.content?.['application/json']?.schema;
      if (request !== undefined) expect(hasExample(request), 'request example').toBe(true);
      for (const [status, response] of Object.entries(op.responses)) {
        const schema = response.content?.['application/json']?.schema;
        if (schema !== undefined && status.startsWith('2')) {
          expect(hasExample(schema), `${status} example`).toBe(true);
        }
      }
    },
  );

  it('has unique operation IDs', () => {
    const ids = operations.map((o) => o.op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('describes every tag', () => {
    expect(doc.tags.filter((t) => !t.description).map((t) => t.name)).toEqual([]);
  });

  it('has component examples that match their schemas', () => {
    const failures: string[] = [];
    for (const [name, schema] of NAMED_SCHEMAS) {
      const example = doc.components.schemas[name]?.example;
      if (example === undefined) {
        failures.push(`${name}: no example`);
        continue;
      }
      const parsed = schema.safeParse(example);
      if (!parsed.success) failures.push(`${name}: ${JSON.stringify(parsed.error.issues)}`);
    }
    expect(failures).toEqual([]);
  });

  it('has problem examples that match the Problem schema', () => {
    const problem = NAMED_SCHEMAS.get('Problem');
    for (const { route, op } of operations) {
      for (const [status, response] of Object.entries(op.responses)) {
        for (const [code, example] of Object.entries(
          response.content?.['application/problem+json']?.examples ?? {},
        )) {
          const value = (example as { value: { status: number; code: string } }).value;
          expect(problem?.safeParse(value).success, `${route} ${code}`).toBe(true);
          expect(value.status, `${route} ${code}`).toBe(Number(status));
        }
      }
    }
  });

  it('documents the security schemes, shared headers and servers', () => {
    const full = doc as unknown as Json & { components: Json; servers: { url: string }[] };
    expect(Object.keys(full.components.securitySchemes as Json)).toEqual([
      'cookieSession',
      'bearerSession',
      'personalAccessToken',
    ]);
    expect(Object.keys(full.components.parameters as Json)).toEqual(
      expect.arrayContaining(['IdempotencyKey', 'EditTime', 'ClientId', 'Client']),
    );
    expect(full.servers[0]?.url).toBe(BASE_URL);
    const create = doc.paths['/api/v1/orgs/{orgId}/tasks']?.post as unknown as {
      parameters: Json[];
    };
    expect(create.parameters).toContainEqual({ $ref: '#/components/parameters/IdempotencyKey' });
    expect(doc.paths['/api/v1/meta']?.get).toMatchObject({ security: [] });
  });
});

describe('AC-8.4 response validation', () => {
  it('is off by default: no endpoint, nothing checked', async () => {
    const { app } = createTestApp();
    expect((await app.request('/__test/response-violations')).status).toBe(404);
  });

  it('checks every /api/v1 response when ROOSTER_VALIDATE_RESPONSES=1', async () => {
    const { app, db } = createTestApp({ env: { ROOSTER_VALIDATE_RESPONSES: '1' } });
    const { jar } = createUserWithSession(app, db, { email: 'anna@example.com' });
    const headers = { cookie: jar.header(), origin: BASE_URL };
    expect((await app.request('/api/v1/me', { headers })).status).toBe(200);
    expect((await app.request(`/api/v1/tasks/${fresh()}`, { headers })).status).toBe(404);
    expect((await app.request('/api/v1/me')).status).toBe(401);
    const report = await (await app.request('/__test/response-violations')).json();
    expect(report).toEqual({ checked: 3, violations: [] });
  });

  it('reports undeclared statuses, wrong media types and schema mismatches', async () => {
    const contract = contractOf('GET /api/v1/me');
    const req = { method: 'GET', path: '/api/v1/me' };
    const json = (body: unknown, status = 200, type = 'application/json') =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });
    expect(await checkResponse(contract, req, json({}, 418), 0)).toMatchObject({
      kind: 'undeclared_status',
    });
    expect(await checkResponse(contract, req, json({}, 200, 'text/html'), 0)).toMatchObject({
      kind: 'content_type',
    });
    expect(await checkResponse(contract, req, json({ id: 1 }), 0)).toMatchObject({
      kind: 'schema',
      route: 'GET /api/v1/me',
    });
    const problem = { type: 'about:blank', title: 'Unauthorized', status: 401, code: 'x' };
    expect(
      await checkResponse(contract, req, json(problem, 401, 'application/problem+json'), 0),
    ).toBeNull();
  });
});
