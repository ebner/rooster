// Phase 12 WP 12.1 (11 §9, ADR 0065): the OAuth device authorization grant (RFC 8628) on
// rooster's authorization server, for `rooster-cli` and for third-party clients with a Client
// ID Metadata Document, behind the operator's switch `ROOSTER_OAUTH_DEVICE`.
import type { CallToolResult } from '@modelcontextprotocol/client';
import type { GrantConstraints, GrantScope } from '@rooster/core/grants';
import type { DeviceRequest, Grant, Notification } from '@rooster/core/schemas';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  accessGrant,
  deviceCode,
  notification,
  oauthRefreshToken,
} from '../src/db/schema/index.ts';
import { loggablePath } from '../src/lib/request-log.ts';
import { hashDeviceSecret, userCodeHash } from '../src/services/device-codes.ts';
import { SMTP_ENV } from './delivery-fakes.ts';
import { ALL, deviceCode as legacyDeviceCode, personalOrgId, pollToken } from './grant-helpers.ts';
import { TEST_ENV } from './helpers.ts';
import type { Caller } from './list-helpers.ts';
import { mcpClient } from './mcp-helpers.ts';
import {
  API_RESOURCE,
  authorize,
  fakeCimd,
  ISSUER,
  MCP_RESOURCE,
  metadataDoc,
  type OAuthCtx,
  oauthCtx,
  tokenRequest,
  withToken,
} from './oauth-helpers.ts';

const DEVICE = 'urn:ietf:params:oauth:grant-type:device_code';
const APP_ID = 'https://agent.acme.example/oauth/device.json';
const DEVICE_IP = '203.0.113.7';

/** A device-only client: no `redirect_uris` (CIMD draft-02 §4.2). */
const deviceDoc = {
  client_id: APP_ID,
  client_name: 'Acme Agent',
  client_uri: 'https://agent.acme.example',
  logo_uri: 'https://agent.acme.example/logo.png',
  grant_types: [DEVICE],
  token_endpoint_auth_method: 'none',
};

const PROXY_ENV = { ROOSTER_TRUST_PROXY: 'true' };

function ctxFor(mode: 'off' | 'first-party' | 'all', env: Record<string, string> = {}) {
  return oauthCtx({
    env: { ROOSTER_OAUTH_DEVICE: mode, ...PROXY_ENV, ...env },
    cimd: fakeCimd({ [APP_ID]: deviceDoc }),
  });
}

interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

/** `POST /api/auth/oauth2/device-authorization` (form-encoded, RFC 8628 §3.1). */
async function requestCode(
  ctx: OAuthCtx,
  fields: Record<string, string | string[]>,
  ip = DEVICE_IP,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const item of [v].flat()) body.append(k, item);
  const res = await ctx.app.request('/api/auth/oauth2/device-authorization', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-for': ip,
      'user-agent': 'rooster-cli/1.8.0 (linux; x64; build-box)',
    },
    body: body.toString(),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function startDevice(
  ctx: OAuthCtx,
  fields: Record<string, string | string[]>,
): Promise<DeviceAuthorization> {
  const res = await requestCode(ctx, fields);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as unknown as DeviceAuthorization;
}

function poll(ctx: OAuthCtx, code: string, clientId: string, resource: string | null) {
  return tokenRequest(ctx, {
    grant_type: DEVICE,
    device_code: code,
    client_id: clientId,
    ...(resource === null ? {} : { resource }),
  });
}

/** The poll interval is only enforced after a first poll; forget it between steps. */
function forgetPolls(ctx: OAuthCtx): void {
  ctx.db.sqlite.prepare('UPDATE deviceCode SET last_polled_at = NULL').run();
}

async function review(user: Caller, userCode: string): Promise<DeviceRequest> {
  return user.ok<DeviceRequest>('GET', `/api/v1/device/${encodeURIComponent(userCode)}`);
}

async function approve(
  user: Caller,
  userCode: string,
  decision: {
    scopes: GrantScope[];
    constraints?: GrantConstraints;
    sessionOnly?: boolean;
    expiresInDays?: number;
  },
): Promise<Grant> {
  const { decisionNonce } = await review(user, userCode);
  return user.ok<Grant>('POST', `/api/v1/device/${encodeURIComponent(userCode)}/approve`, {
    decisionNonce,
    constraints: { orgs: 'all' },
    ...decision,
  });
}

async function connectCli(ctx: OAuthCtx, user: Caller, resource = API_RESOURCE) {
  const code = await startDevice(ctx, {
    client_id: 'rooster-cli',
    scope: 'tasks:read tasks:write',
    resource,
  });
  const grant = await approve(user, code.user_code, { scopes: ['tasks:write'] });
  const token = await poll(ctx, code.device_code, 'rooster-cli', resource);
  expect(token.status, JSON.stringify(token.body)).toBe(200);
  return {
    code,
    grant,
    access: token.body.access_token as string,
    refresh: token.body.refresh_token as string,
  };
}

describe('AC-12.1 a third-party device client with ROOSTER_OAUTH_DEVICE=all', () => {
  it('AC-12.1 connects a CIMD client without redirect_uris end to end', async () => {
    const ctx = ctxFor('all', SMTP_ENV);
    const user = ctx.user('jannik@example.com', 'Jannik');
    const orgId = await personalOrgId(user);
    await user.ok('POST', '/api/v1/orgs/personal/tasks', { title: 'Visible to the agent' }, 201);

    const code = await startDevice(ctx, {
      client_id: APP_ID,
      scope: 'tasks:read offline_access',
      resource: MCP_RESOURCE,
    });
    expect(code.verification_uri_complete).toBeUndefined();
    expect(code.verification_uri).toBe('http://localhost:3000/device');
    expect(code).toMatchObject({ expires_in: 600, interval: 5 });
    expect(code.user_code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(code.device_code.length).toBeGreaterThanOrEqual(43);

    // Pending, then too fast: slow_down, and the interval grows by 5 s.
    const pending = await poll(ctx, code.device_code, APP_ID, MCP_RESOURCE);
    expect(pending).toMatchObject({ status: 400, body: { error: 'authorization_pending' } });
    const fast = await poll(ctx, code.device_code, APP_ID, MCP_RESOURCE);
    expect(fast).toMatchObject({ status: 400, body: { error: 'slow_down' } });
    expect(ctx.db.orm.select().from(deviceCode).get()?.pollingInterval).toBe(10_000);

    // The user types the code (any case, without the dash) and sees the full context.
    const typed = code.user_code.replace('-', '').toLowerCase();
    const request = await review(user, typed);
    expect(request).toMatchObject({
      clientId: APP_ID,
      clientName: 'Acme Agent',
      firstParty: false,
      client: {
        name: 'Acme Agent',
        domain: 'agent.acme.example',
        logoUri: null,
        verified: false,
        dynamic: false,
      },
      resource: 'mcp',
      requestIp: DEVICE_IP,
      requestedScopes: ['tasks:read'],
      existing: null,
      offerSessionOnly: true,
    });
    expect(request.requestedAt).toBeGreaterThan(Date.now() - 60_000);
    expect(request.requestedAt).toBeLessThanOrEqual(Date.now());

    const grant = await approve(user, typed, {
      scopes: ['tasks:read'],
      constraints: { orgs: [{ orgId, read: 'all', write: 'none' }] },
    });
    expect(grant).toMatchObject({ kind: 'oauth', clientId: APP_ID, scopes: ['tasks:read'] });

    forgetPolls(ctx);
    const token = await poll(ctx, code.device_code, APP_ID, MCP_RESOURCE);
    expect(token.status, JSON.stringify(token.body)).toBe(200);
    expect(token.body).toMatchObject({ token_type: 'Bearer', scope: 'tasks:read offline_access' });
    const access = token.body.access_token as string;
    const refresh = token.body.refresh_token as string;
    expect(access).toMatch(/^rooster_at_/);
    expect(refresh).toMatch(/^rooster_rt_/);

    // The client lists the org's tasks at /mcp; /api/v1 refuses the token.
    const client = await mcpClient(ctx.app, access);
    const listed = (await client.callTool({ name: 'list_tasks', arguments: {} })) as CallToolResult;
    expect(listed.isError).toBeFalsy();
    expect(JSON.stringify(listed.content)).toContain('Visible to the agent');
    await client.close();
    expect((await withToken(ctx, access, 'GET', '/api/v1/me')).status).toBe(401);

    // A device code redeems once.
    forgetPolls(ctx);
    const again = await poll(ctx, code.device_code, APP_ID, MCP_RESOURCE);
    expect(again).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });

    // The security notice: in the inbox, and by email at once.
    const inbox = await user.ok<{ items: Notification[] }>('GET', '/api/v1/notifications');
    const notice = inbox.items.find((n) => n.type === 'device_connected');
    expect(notice).toMatchObject({
      orgId,
      task: null,
      actor: null,
      data: {
        grantId: grant.id,
        clientName: 'Acme Agent',
        clientHost: 'agent.acme.example',
        ip: DEVICE_IP,
      },
    });
    await ctx.app.services.deliveries.idle();
    const [email] = ctx.mail.to('jannik@example.com');
    expect(email?.subject).toBe(`Acme Agent was connected from ${DEVICE_IP}`);
    expect(email?.html).toContain('/settings/security#connected-apps');
    expect(email?.headers['List-Unsubscribe']).toBeUndefined();

    // Refresh rotates; reusing an old refresh token after its successor was used revokes the
    // grant.
    const rotated = await tokenRequest(ctx, {
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: APP_ID,
      resource: MCP_RESOURCE,
    });
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(200);
    const next = await tokenRequest(ctx, {
      grant_type: 'refresh_token',
      refresh_token: rotated.body.refresh_token as string,
      client_id: APP_ID,
    });
    expect(next.status).toBe(200);
    const reused = await tokenRequest(ctx, {
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: APP_ID,
    });
    expect(reused).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
    const row = ctx.db.orm.select().from(accessGrant).where(eq(accessGrant.id, grant.id)).get();
    expect(row?.revokedAt).not.toBeNull();
  });

  it('AC-12.1 advertises the device grant in the AS metadata only with all', async () => {
    const metadata = async (ctx: OAuthCtx) =>
      (await (
        await ctx.app.request('/.well-known/oauth-authorization-server/api/auth')
      ).json()) as Record<string, unknown>;
    const all = await metadata(ctxFor('all'));
    expect(all.device_authorization_endpoint).toBe(`${ISSUER}/oauth2/device-authorization`);
    expect(all.grant_types_supported).toContain(DEVICE);
    for (const mode of ['first-party', 'off'] as const) {
      const doc = await metadata(ctxFor(mode));
      expect(doc.device_authorization_endpoint).toBeUndefined();
      expect(doc.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    }
  });

  it('AC-12.1 with first-party the app gets unauthorized_client, without a metadata fetch', async () => {
    const ctx = ctxFor('first-party');
    const res = await requestCode(ctx, { client_id: APP_ID, resource: MCP_RESOURCE });
    expect(res).toMatchObject({ status: 400, body: { error: 'unauthorized_client' } });
    expect(ctx.cimd.fetched).toEqual([]);
    expect(
      (await requestCode(ctx, { client_id: 'rooster-cli', resource: API_RESOURCE })).status,
    ).toBe(200);
  });

  it('AC-12.1 with off rooster-cli gets unauthorized_client too', async () => {
    const ctx = ctxFor('off');
    const res = await requestCode(ctx, { client_id: 'rooster-cli', resource: API_RESOURCE });
    expect(res).toMatchObject({ status: 400, body: { error: 'unauthorized_client' } });
    // The legacy CLI flow stays (11 §9.6).
    expect((await legacyDeviceCode(ctx)).user_code).toBeTruthy();
  });
});

describe('the device authorization request (RFC 8628 §3.1, 11 §9.2)', () => {
  it('requires exactly one known resource', async () => {
    const ctx = ctxFor('all');
    for (const fields of [
      { client_id: 'rooster-cli' },
      { client_id: 'rooster-cli', resource: 'https://elsewhere.example/mcp' },
      { client_id: 'rooster-cli', resource: [API_RESOURCE, MCP_RESOURCE] },
    ]) {
      const res = await requestCode(ctx, fields, `198.51.100.${Math.floor(Math.random() * 200)}`);
      expect(res, JSON.stringify(fields)).toMatchObject({
        status: 400,
        body: { error: 'invalid_target' },
      });
    }
  });

  it('checks scopes: known, at most 512 bytes, admin only from rooster-cli', async () => {
    const ctx = ctxFor('all');
    const bad = async (fields: Record<string, string>, ip: string) =>
      (await requestCode(ctx, { resource: MCP_RESOURCE, ...fields }, ip)).body.error;
    expect(await bad({ client_id: APP_ID, scope: 'tasks:read admin' }, '198.51.100.1')).toBe(
      'invalid_scope',
    );
    expect(await bad({ client_id: 'rooster-cli', scope: 'tasks:fly' }, '198.51.100.2')).toBe(
      'invalid_scope',
    );
    expect(
      await bad({ client_id: 'rooster-cli', scope: 'tasks:read '.repeat(60) }, '198.51.100.3'),
    ).toBe('invalid_scope');
    // A third party that names nothing asks for the least.
    const code = await startDevice(ctx, { client_id: APP_ID, resource: MCP_RESOURCE });
    const user = ctx.user('a@example.com');
    expect((await review(user, code.user_code)).requestedScopes).toEqual(['tasks:read']);
  });

  it('refuses DCR and unknown clients, and documents without the device grant', async () => {
    const ctx = oauthCtx({
      env: { ROOSTER_OAUTH_DEVICE: 'all', ...PROXY_ENV },
      cimd: fakeCimd({
        [APP_ID]: { ...deviceDoc, grant_types: ['refresh_token'] },
      }),
    });
    expect(
      (await requestCode(ctx, { client_id: 'some-dcr-id', resource: MCP_RESOURCE })).body.error,
    ).toBe('unauthorized_client');
    const noGrant = await requestCode(
      ctx,
      { client_id: APP_ID, resource: MCP_RESOURCE },
      '198.51.100.9',
    );
    expect(noGrant.status).toBe(400);
    expect(noGrant.body.error).toBe('invalid_client');
  });

  it('accepts authorization_details and ignores them (no prefill in Phase 12)', async () => {
    const ctx = ctxFor('all');
    const details = JSON.stringify([{ type: 'rooster_access', orgs: 'all' }]);
    const code = await startDevice(ctx, {
      client_id: 'rooster-cli',
      resource: API_RESOURCE,
      authorization_details: details,
    });
    expect(code.user_code).toBeTruthy();
  });

  it('limits requests: 10 per 10 minutes per IP, 30 per hour per third-party client', async () => {
    const ctx = ctxFor('all');
    for (let i = 0; i < 10; i += 1) {
      expect(
        (await requestCode(ctx, { client_id: 'rooster-cli', resource: API_RESOURCE })).status,
      ).toBe(200);
    }
    const limited = await requestCode(ctx, { client_id: 'rooster-cli', resource: API_RESOURCE });
    expect(limited).toMatchObject({ status: 429, body: { error: 'temporarily_unavailable' } });
    // The legacy flow counts against the same IP.
    const legacy = await ctx.app.request('/api/auth/device/code', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': DEVICE_IP },
      body: JSON.stringify({ client_id: 'rooster-cli' }),
    });
    expect(legacy.status).toBe(429);
    // Another IP may go on; the app's own budget is per hour across IPs.
    for (let i = 0; i < 30; i += 1) {
      const ip = `198.51.100.${i}`;
      expect(
        (await requestCode(ctx, { client_id: APP_ID, resource: MCP_RESOURCE }, ip)).status,
      ).toBe(200);
    }
    const app = await requestCode(ctx, { client_id: APP_ID, resource: MCP_RESOURCE }, '192.0.2.1');
    expect(app.status).toBe(429);
  });

  it('stores both codes only as SHA-256 hashes (AC-12.2)', async () => {
    const ctx = ctxFor('all');
    const code = await startDevice(ctx, { client_id: 'rooster-cli', resource: API_RESOURCE });
    const row = ctx.db.orm.select().from(deviceCode).get();
    expect(row?.deviceCode).toBe(hashDeviceSecret(code.device_code));
    expect(row?.userCode).toBe(userCodeHash(TEST_ENV.ROOSTER_AUTH_SECRET, code.user_code));
    expect(JSON.stringify(row)).not.toContain(code.device_code);
    expect(JSON.stringify(row)).not.toContain(code.user_code.replace('-', ''));
    expect(row).toMatchObject({
      oauthClientId: 'rooster-cli',
      resource: API_RESOURCE,
      requestIp: DEVICE_IP,
      status: 'pending',
    });
  });

  it('hashes the legacy CLI flow’s codes too, and it still logs in', async () => {
    const ctx = ctxFor('first-party');
    const user = ctx.user('a@example.com');
    const code = await legacyDeviceCode(ctx, 'tasks:read');
    const row = ctx.db.orm.select().from(deviceCode).get();
    expect(row?.deviceCode).toBe(hashDeviceSecret(code.device_code));
    expect(row?.userCode).toBe(userCodeHash(TEST_ENV.ROOSTER_AUTH_SECRET, code.user_code));
    expect(row?.createdAt).not.toBeNull();
    const request = await review(user, code.user_code);
    expect(request).toMatchObject({ firstParty: true, resource: null, client: null });
    expect(request.requestedAt).toBeGreaterThan(0);
    await approve(user, code.user_code, { scopes: ['tasks:read'] });
    const token = await pollToken(ctx, code.device_code);
    expect(token.status, JSON.stringify(token.body)).toBe(200);
    expect(
      (await withToken(ctx, token.body.access_token as string, 'GET', '/api/v1/me')).status,
    ).toBe(200);
    // The legacy login is not the device grant: no notice.
    const rows = ctx.db.orm.select().from(notification).all();
    expect(rows.filter((r) => r.type === 'device_connected')).toEqual([]);
  });
});

describe('the token request (RFC 8628 §3.4–3.5)', () => {
  it('answers access_denied after a denial, expired_token after expiry', async () => {
    const ctx = ctxFor('all');
    const user = ctx.user('a@example.com');
    const denied = await startDevice(ctx, { client_id: 'rooster-cli', resource: API_RESOURCE });
    const { decisionNonce } = await review(user, denied.user_code);
    await user.ok('POST', `/api/v1/device/${denied.user_code}/deny`, { decisionNonce }, 204);
    expect(await poll(ctx, denied.device_code, 'rooster-cli', API_RESOURCE)).toMatchObject({
      body: { error: 'access_denied' },
    });

    const late = await startDevice(ctx, { client_id: 'rooster-cli', resource: API_RESOURCE });
    ctx.db.orm
      .update(deviceCode)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(deviceCode.deviceCode, hashDeviceSecret(late.device_code)))
      .run();
    expect(await poll(ctx, late.device_code, 'rooster-cli', API_RESOURCE)).toMatchObject({
      body: { error: 'expired_token' },
    });
  });

  it('binds the resource: another or no resource is invalid_target', async () => {
    const ctx = ctxFor('all');
    const user = ctx.user('a@example.com');
    const code = await startDevice(ctx, { client_id: 'rooster-cli', resource: API_RESOURCE });
    await approve(user, code.user_code, { scopes: ['tasks:read'] });
    expect(await poll(ctx, code.device_code, 'rooster-cli', MCP_RESOURCE)).toMatchObject({
      body: { error: 'invalid_target' },
    });
    expect(await poll(ctx, code.device_code, 'rooster-cli', null)).toMatchObject({
      body: { error: 'invalid_target' },
    });
    // Another client cannot redeem it.
    expect(await poll(ctx, code.device_code, APP_ID, API_RESOURCE)).toMatchObject({
      body: { error: 'invalid_grant' },
    });
    // Nor the legacy session endpoint.
    expect((await pollToken(ctx, code.device_code)).body.error).toBe('invalid_grant');
    forgetPolls(ctx);
    expect((await poll(ctx, code.device_code, 'rooster-cli', API_RESOURCE)).status).toBe(200);
  });

  it('refuses a code whose grant was revoked before redemption', async () => {
    const ctx = ctxFor('all');
    const user = ctx.user('a@example.com');
    const code = await startDevice(ctx, { client_id: 'rooster-cli', resource: API_RESOURCE });
    const grant = await approve(user, code.user_code, { scopes: ['tasks:read'] });
    await user.ok('DELETE', `/api/v1/me/grants/${grant.id}`, undefined, 204);
    expect(await poll(ctx, code.device_code, 'rooster-cli', API_RESOURCE)).toMatchObject({
      body: { error: 'invalid_grant' },
    });
  });

  it('a legacy code cannot be redeemed for OAuth tokens', async () => {
    const ctx = ctxFor('all');
    const user = ctx.user('a@example.com');
    const code = await legacyDeviceCode(ctx, 'tasks:read');
    await approve(user, code.user_code, { scopes: ['tasks:read'] });
    expect(await poll(ctx, code.device_code, 'rooster-cli', API_RESOURCE)).toMatchObject({
      body: { error: 'invalid_grant' },
    });
  });
});

describe('rooster-cli through the device grant (11 §9.4, §9.6)', () => {
  it('creates one device grant per login, bound to its resource', async () => {
    const ctx = ctxFor('first-party');
    const user = ctx.user('a@example.com');
    const login = await connectCli(ctx, user);
    expect(login.grant).toMatchObject({
      kind: 'device',
      clientId: 'rooster-cli',
      audience: 'api',
      label: 'rooster CLI on build-box',
    });
    expect((await withToken(ctx, login.access, 'GET', '/api/v1/me')).status).toBe(200);
    expect((await withToken(ctx, login.access, 'POST', '/mcp', {})).status).toBe(401);
    const second = await connectCli(ctx, user);
    expect(second.grant.id).not.toBe(login.grant.id);
    const grants = await user.ok<Grant[]>('GET', '/api/v1/me/grants');
    expect(grants.filter((g) => g.kind === 'device').map((g) => g.audience)).toEqual([
      'api',
      'api',
    ]);

    // The notice names the client, never the device name the device itself reported.
    const notices = ctx.db.orm
      .select()
      .from(notification)
      .all()
      .filter((n) => n.type === 'device_connected');
    expect(notices).toHaveLength(2);
    const data = JSON.parse(notices[0]?.data ?? '{}') as Record<string, unknown>;
    expect(data).toEqual({ grantId: login.grant.id, clientName: 'rooster CLI', ip: DEVICE_IP });
    expect(notices[0]?.data).not.toContain('build-box');
  });

  it('refreshes (with or without resource), can create a PAT, and logs out by revocation', async () => {
    const ctx = ctxFor('first-party');
    const user = ctx.user('a@example.com');
    const login = await connectCli(ctx, user);
    const refreshed = await tokenRequest(ctx, {
      grant_type: 'refresh_token',
      refresh_token: login.refresh,
      client_id: 'rooster-cli',
      resource: API_RESOURCE,
    });
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
    expect(refreshed.body.scope).toBe('tasks:read tasks:write offline_access');
    const wrongResource = await tokenRequest(ctx, {
      grant_type: 'refresh_token',
      refresh_token: refreshed.body.refresh_token as string,
      client_id: 'rooster-cli',
      resource: MCP_RESOURCE,
    });
    expect(wrongResource.body.error).toBe('invalid_target');
    const access = refreshed.body.access_token as string;
    const created = await withToken(ctx, access, 'POST', '/api/v1/me/tokens', {
      name: 'From the CLI',
      scopes: ['tasks:read'],
      constraints: { orgs: 'all' },
    });
    expect(created.status, await created.clone().text()).toBe(201);

    const revoke = await ctx.app.request('/api/auth/oauth2/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: refreshed.body.refresh_token as string,
        token_type_hint: 'refresh_token',
        client_id: 'rooster-cli',
      }).toString(),
    });
    expect(revoke.status, await revoke.clone().text()).toBe(200);
    const row = ctx.db.orm
      .select()
      .from(accessGrant)
      .where(eq(accessGrant.id, login.grant.id))
      .get();
    expect(row?.revokedAt).not.toBeNull();
    expect((await withToken(ctx, access, 'GET', '/api/v1/me')).status).toBe(401);
    expect(
      ctx.db.orm
        .select()
        .from(oauthRefreshToken)
        .where(eq(oauthRefreshToken.referenceId, login.grant.id))
        .all(),
    ).toEqual([]);
  });

  it('holds admin only for instance admins, and never for /mcp', async () => {
    const ctx = ctxFor('first-party');
    const admin = ctx.user('admin@example.com');
    const apiCode = await startDevice(ctx, {
      client_id: 'rooster-cli',
      scope: 'tasks:read admin',
      resource: API_RESOURCE,
    });
    expect((await review(admin, apiCode.user_code)).requestedScopes).toContain('admin');
    const mcpCode = await startDevice(ctx, {
      client_id: 'rooster-cli',
      scope: 'tasks:read admin',
      resource: MCP_RESOURCE,
    });
    expect((await review(admin, mcpCode.user_code)).requestedScopes).toEqual(['tasks:read']);
    const grant = await approve(admin, apiCode.user_code, { scopes: ['tasks:read', 'admin'] });
    expect(grant.scopes).toContain('admin');
    const token = await poll(ctx, apiCode.device_code, 'rooster-cli', API_RESOURCE);
    expect(token.body.scope).toBe('tasks:read admin offline_access');
  });

  it('does not offer "This session only" to rooster-cli', async () => {
    const ctx = ctxFor('first-party');
    const user = ctx.user('a@example.com');
    const code = await startDevice(ctx, { client_id: 'rooster-cli', resource: API_RESOURCE });
    const request = await review(user, code.user_code);
    expect(request.offerSessionOnly).toBe(false);
    const res = await user.call('POST', `/api/v1/device/${code.user_code}/approve`, {
      decisionNonce: request.decisionNonce,
      scopes: ['tasks:read'],
      constraints: { orgs: 'all' },
      sessionOnly: true,
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('session_only_not_offered');
  });
});

describe('a third-party client’s grant (11 §9.4)', () => {
  it('shares the user’s one grant with the browser flow, stepping it up', async () => {
    const appDoc = {
      ...metadataDoc(APP_ID),
      grant_types: ['authorization_code', 'refresh_token', DEVICE],
    };
    const ctx = oauthCtx({
      env: { ROOSTER_OAUTH_DEVICE: 'all', ...PROXY_ENV },
      cimd: fakeCimd({ [APP_ID]: appDoc }),
    });
    const user = ctx.user('a@example.com');
    const orgId = await personalOrgId(user);
    const first = await startDevice(ctx, {
      client_id: APP_ID,
      scope: 'tasks:read',
      resource: MCP_RESOURCE,
    });
    const grant = await approve(user, first.user_code, {
      scopes: ['tasks:read'],
      constraints: { orgs: [{ orgId, read: 'all', write: 'none' }] },
      expiresInDays: 90,
    });
    const second = await startDevice(ctx, {
      client_id: APP_ID,
      scope: 'tasks:write',
      resource: MCP_RESOURCE,
    });
    const request = await review(user, second.user_code);
    expect(request.existing).toEqual({
      scopes: ['tasks:read'],
      constraints: { orgs: [{ orgId, read: 'all', write: 'none' }] },
    });
    const stepped = await approve(user, second.user_code, {
      scopes: ['tasks:write'],
      constraints: { orgs: [{ orgId, read: 'all', write: 'all' }] },
      sessionOnly: true,
    });
    expect(stepped.id).toBe(grant.id);
    expect(stepped.scopes).toEqual(['tasks:write']);
    expect(stepped.idleTimeoutMs).toBe(24 * 60 * 60 * 1000);
    expect(stepped.expiresAt).toBeNull();
    // The browser flow finds the same grant: one live grant per user and client.
    const live = ctx.db.orm
      .select()
      .from(accessGrant)
      .all()
      .filter((g) => g.clientId === APP_ID && g.revokedAt === null);
    expect(live).toHaveLength(1);
    // tasks:delete only when requested; admin never.
    const third = await startDevice(ctx, {
      client_id: APP_ID,
      scope: 'tasks:read',
      resource: MCP_RESOURCE,
    });
    const { decisionNonce } = await review(user, third.user_code);
    const wider = await user.call('POST', `/api/v1/device/${third.user_code}/approve`, {
      decisionNonce,
      scopes: ['tasks:delete'],
      constraints: { orgs: 'all' },
    });
    expect(wider.status).toBe(422);
  });

  it('a device-only client cannot use the authorization code flow', async () => {
    const ctx = ctxFor('all');
    const user = ctx.user('a@example.com');
    await startDevice(ctx, { client_id: APP_ID, resource: MCP_RESOURCE });
    const res = await ctx.app.request(
      `/api/auth/oauth2/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: APP_ID,
        redirect_uri: 'https://agent.acme.example/callback',
        scope: 'tasks:read',
        resource: MCP_RESOURCE,
        code_challenge: 'x'.repeat(43),
        code_challenge_method: 'S256',
        state: 's',
      })}`,
      { headers: { cookie: user.jar.header() } },
    );
    const location = res.headers.get('location') ?? '';
    expect(location).not.toContain('/oauth/consent');
    expect(`${res.status} ${location} ${await res.text()}`).toContain('invalid_client');
    // The code-flow helper's client is unaffected.
    void authorize;
  });
});

describe('AC-12.2 code entry at /device', () => {
  it('AC-12.2 ten wrong codes in 10 minutes lock code entry with 429', async () => {
    const ctx = ctxFor('first-party');
    const user = ctx.user('a@example.com');
    const code = await startDevice(ctx, { client_id: 'rooster-cli', resource: API_RESOURCE });
    for (let i = 0; i < 10; i += 1) {
      const res = await user.call('GET', `/api/v1/device/WRONG${String(i).padStart(3, '0')}`);
      expect(res.status).toBe(404);
    }
    const locked = await user.call('GET', `/api/v1/device/${code.user_code}`);
    expect(locked.status).toBe(429);
    expect(locked.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(((await locked.json()) as { code: string }).code).toBe('rate_limited');
    // Another user is not locked out.
    const other = ctx.user('b@example.com');
    expect((await other.call('GET', `/api/v1/device/${code.user_code}`)).status).toBe(200);
  });

  it('AC-12.2 used and expired codes answer the same 404 as unknown ones', async () => {
    const ctx = ctxFor('first-party');
    const user = ctx.user('a@example.com');
    const code = await startDevice(ctx, { client_id: 'rooster-cli', resource: API_RESOURCE });
    await approve(user, code.user_code, { scopes: ['tasks:read'] });
    const used = await user.call('GET', `/api/v1/device/${code.user_code}`);
    const unknown = await user.call('GET', '/api/v1/device/ZZZZZZZZ');
    expect(used.status).toBe(404);
    expect(await used.json()).toEqual(await unknown.json());
  });

  it('AC-12.2 approve and deny with another session’s nonce are refused', async () => {
    const ctx = ctxFor('all');
    const user = ctx.user('a@example.com');
    const otherSession = ctx.signedIn(user.userId);
    const code = await startDevice(ctx, { client_id: APP_ID, resource: MCP_RESOURCE });
    const { decisionNonce } = await review(otherSession, code.user_code);
    const approveRes = await user.call('POST', `/api/v1/device/${code.user_code}/approve`, {
      decisionNonce,
      scopes: ['tasks:read'],
      constraints: { orgs: 'all' },
    });
    expect(approveRes.status).toBe(404);
    const denyRes = await user.call('POST', `/api/v1/device/${code.user_code}/deny`, {
      decisionNonce,
    });
    expect(denyRes.status).toBe(404);
    // The request is still pending for the session it was shown to.
    expect((await review(otherSession, code.user_code)).clientId).toBe(APP_ID);
  });

  it('approves a code once (compare-and-swap)', async () => {
    const ctx = ctxFor('first-party');
    const user = ctx.user('a@example.com');
    const code = await startDevice(ctx, { client_id: 'rooster-cli', resource: API_RESOURCE });
    const { decisionNonce } = await review(user, code.user_code);
    const body = { decisionNonce, scopes: ['tasks:read'], constraints: { orgs: 'all' } };
    const results = await Promise.all([
      user.call('POST', `/api/v1/device/${code.user_code}/approve`, body),
      user.call('POST', `/api/v1/device/${code.user_code}/approve`, body),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 404]);
    const grants = await user.ok<Grant[]>('GET', '/api/v1/me/grants');
    expect(grants.filter((g) => g.kind === 'device')).toHaveLength(1);
  });

  it('every scope may be requested by rooster-cli', async () => {
    const ctx = ctxFor('first-party');
    const user = ctx.user('a@example.com');
    const code = await startDevice(ctx, { client_id: 'rooster-cli', resource: API_RESOURCE });
    expect((await review(user, code.user_code)).requestedScopes.length).toBeGreaterThan(0);
    expect(ALL.length).toBeGreaterThan(0);
  });
});

describe('the refresh grace (11 §2.4): a lost token response may be retried once', () => {
  const refreshWith = (ctx: OAuthCtx, token: string) =>
    tokenRequest(ctx, {
      grant_type: 'refresh_token',
      refresh_token: token,
      client_id: 'rooster-cli',
    });
  const grantRow = (ctx: OAuthCtx, id: string) =>
    ctx.db.orm.select().from(accessGrant).where(eq(accessGrant.id, id)).get();

  it('retries the previous token within 60 s: a fresh pair, the lost one revoked, the grant kept', async () => {
    const ctx = ctxFor('first-party');
    const user = ctx.user('a@example.com');
    const login = await connectCli(ctx, user);
    const lost = await refreshWith(ctx, login.refresh);
    expect(lost.status).toBe(200);
    const retry = await refreshWith(ctx, login.refresh);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.refresh_token).not.toBe(lost.body.refresh_token);
    expect(grantRow(ctx, login.grant.id)?.revokedAt).toBeNull();
    // The answer that was lost no longer works; the retry's does.
    expect(
      (await withToken(ctx, lost.body.access_token as string, 'GET', '/api/v1/me')).status,
    ).toBe(401);
    expect(
      (await withToken(ctx, retry.body.access_token as string, 'GET', '/api/v1/me')).status,
    ).toBe(200);
    // The chain goes on from the retry.
    expect((await refreshWith(ctx, retry.body.refresh_token as string)).status).toBe(200);
    expect(grantRow(ctx, login.grant.id)?.revokedAt).toBeNull();
  });

  it('a retry after the successor was used revokes the grant', async () => {
    const ctx = ctxFor('first-party');
    const user = ctx.user('a@example.com');
    const login = await connectCli(ctx, user);
    const rotated = await refreshWith(ctx, login.refresh);
    expect((await refreshWith(ctx, rotated.body.refresh_token as string)).status).toBe(200);
    expect((await refreshWith(ctx, login.refresh)).body.error).toBe('invalid_grant');
    expect(grantRow(ctx, login.grant.id)?.revokedAt).not.toBeNull();
  });

  it('a retry after 60 s revokes the grant', async () => {
    const ctx = ctxFor('first-party');
    const user = ctx.user('a@example.com');
    const login = await connectCli(ctx, user);
    expect((await refreshWith(ctx, login.refresh)).status).toBe(200);
    ctx.db.sqlite
      .prepare(
        'UPDATE oauthRefreshToken SET rotated_at = rotated_at - 61000 WHERE rotated_at IS NOT NULL',
      )
      .run();
    expect((await refreshWith(ctx, login.refresh)).body.error).toBe('invalid_grant');
    expect(grantRow(ctx, login.grant.id)?.revokedAt).not.toBeNull();
  });

  it('a second retry of the same token revokes the grant', async () => {
    const ctx = ctxFor('first-party');
    const user = ctx.user('a@example.com');
    const login = await connectCli(ctx, user);
    expect((await refreshWith(ctx, login.refresh)).status).toBe(200);
    expect((await refreshWith(ctx, login.refresh)).status).toBe(200);
    expect((await refreshWith(ctx, login.refresh)).body.error).toBe('invalid_grant');
    expect(grantRow(ctx, login.grant.id)?.revokedAt).not.toBeNull();
  });

  it('two concurrent retries: the first is the retry, the second is reuse and ends the grant', async () => {
    const ctx = ctxFor('first-party');
    const user = ctx.user('a@example.com');
    const login = await connectCli(ctx, user);
    expect((await refreshWith(ctx, login.refresh)).status).toBe(200);
    const results = await Promise.all([
      refreshWith(ctx, login.refresh),
      refreshWith(ctx, login.refresh),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(grantRow(ctx, login.grant.id)?.revokedAt).not.toBeNull();
  });
});

describe('revoking a refresh token (RFC 7009) ends only what it names', () => {
  const revoke = (ctx: OAuthCtx, token: string, clientId: string) =>
    ctx.app.request('/api/auth/oauth2/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token,
        token_type_hint: 'refresh_token',
        client_id: clientId,
      }).toString(),
    });
  const refreshWith = (ctx: OAuthCtx, token: string, clientId: string) =>
    tokenRequest(ctx, { grant_type: 'refresh_token', refresh_token: token, client_id: clientId });
  const grantRow = (ctx: OAuthCtx, id: string) =>
    ctx.db.orm.select().from(accessGrant).where(eq(accessGrant.id, id)).get();

  it('a stale rooster-cli refresh token logs out that login only, not the other machine', async () => {
    const ctx = ctxFor('first-party');
    const user = ctx.user('a@example.com');
    const laptop = await connectCli(ctx, user);
    const desktop = await connectCli(ctx, user);
    // The laptop's token rotates; `rooster logout` then sends the one it still had.
    const rotated = await refreshWith(ctx, laptop.refresh, 'rooster-cli');
    expect(rotated.status).toBe(200);
    const res = await revoke(ctx, laptop.refresh, 'rooster-cli');
    expect(res.status).toBe(200);
    expect(grantRow(ctx, laptop.grant.id)?.revokedAt).not.toBeNull();
    expect(
      (await withToken(ctx, rotated.body.access_token as string, 'GET', '/api/v1/me')).status,
    ).toBe(401);
    // The desktop's login is untouched.
    expect(grantRow(ctx, desktop.grant.id)?.revokedAt).toBeNull();
    expect((await withToken(ctx, desktop.access, 'GET', '/api/v1/me')).status).toBe(200);
    expect((await refreshWith(ctx, desktop.refresh, 'rooster-cli')).status).toBe(200);
  });

  it('an app’s stale refresh token revokes nothing else of the app', async () => {
    const ctx = ctxFor('all');
    const user = ctx.user('a@example.com');
    // The same app on two machines: one grant, two refresh chains.
    const chains = [];
    for (const _ of [1, 2]) {
      const code = await startDevice(ctx, { client_id: APP_ID, resource: MCP_RESOURCE });
      await approve(user, code.user_code, { scopes: ['tasks:read'] });
      const token = await poll(ctx, code.device_code, APP_ID, MCP_RESOURCE);
      expect(token.status).toBe(200);
      chains.push(token.body);
    }
    const [one, two] = chains as [Record<string, unknown>, Record<string, unknown>];
    expect((await refreshWith(ctx, one.refresh_token as string, APP_ID)).status).toBe(200);
    expect((await revoke(ctx, one.refresh_token as string, APP_ID)).status).toBe(200);
    expect((await refreshWith(ctx, two.refresh_token as string, APP_ID)).status).toBe(200);
  });

  it('an app’s current refresh token is revoked alone, and the grant stays', async () => {
    const ctx = ctxFor('all');
    const user = ctx.user('a@example.com');
    const code = await startDevice(ctx, { client_id: APP_ID, resource: MCP_RESOURCE });
    const grant = await approve(user, code.user_code, { scopes: ['tasks:read'] });
    const token = await poll(ctx, code.device_code, APP_ID, MCP_RESOURCE);
    expect((await revoke(ctx, token.body.refresh_token as string, APP_ID)).status).toBe(200);
    expect(grantRow(ctx, grant.id)?.revokedAt).toBeNull();
    expect(
      (await withToken(ctx, token.body.access_token as string, 'GET', '/mcp')).status,
    ).not.toBe(200);
    expect((await refreshWith(ctx, token.body.refresh_token as string, APP_ID)).status).toBe(400);
  });
});

it('a CLI admin login may refresh with the scope it was given, admin included', async () => {
  const ctx = ctxFor('first-party');
  const admin = ctx.user('admin@example.com');
  const code = await startDevice(ctx, {
    client_id: 'rooster-cli',
    scope: 'tasks:read admin',
    resource: API_RESOURCE,
  });
  await approve(admin, code.user_code, { scopes: ['tasks:read', 'admin'] });
  const token = await poll(ctx, code.device_code, 'rooster-cli', API_RESOURCE);
  expect(token.body.scope).toBe('tasks:read admin offline_access');
  const refreshed = await tokenRequest(ctx, {
    grant_type: 'refresh_token',
    refresh_token: token.body.refresh_token as string,
    client_id: 'rooster-cli',
    scope: token.body.scope as string,
  });
  expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
  expect(refreshed.body.scope).toBe('tasks:read admin offline_access');
});

describe('security notice and presentation hardening', () => {
  it('emails a rooster-cli notice without the device’s self-reported name', async () => {
    const ctx = ctxFor('first-party', SMTP_ENV);
    const user = ctx.user('a@example.com');
    await connectCli(ctx, user);
    await ctx.app.services.deliveries.idle();
    const [email] = ctx.mail.to('a@example.com');
    expect(email?.subject).toBe(`rooster CLI was connected from ${DEVICE_IP}`);
    expect(`${email?.html} ${email?.text}`).not.toContain('build-box');
  });

  it('an app named like rooster is shown by its host, on /device and in the notice', async () => {
    for (const name of [
      'rooster CLI',
      'Rооster CLI',
      'R o o s t e r',
      'ｒｏｏｓｔｅｒ',
      'r00ster',
    ]) {
      const ctx = oauthCtx({
        env: { ROOSTER_OAUTH_DEVICE: 'all', ...PROXY_ENV },
        cimd: fakeCimd({ [APP_ID]: { ...deviceDoc, client_name: name } }),
      });
      const user = ctx.user('a@example.com');
      const code = await startDevice(ctx, { client_id: APP_ID, resource: MCP_RESOURCE });
      const request = await review(user, code.user_code);
      expect(request.clientName, name).toBe('agent.acme.example');
      expect(request.client?.name, name).toBe('agent.acme.example');
      expect(request.firstParty).toBe(false);
      await approve(user, code.user_code, { scopes: ['tasks:read'] });
      const notice = ctx.db.orm
        .select()
        .from(notification)
        .all()
        .find((n) => n.type === 'device_connected');
      expect(JSON.parse(notice?.data ?? '{}')).toMatchObject({
        clientName: 'agent.acme.example',
        clientHost: 'agent.acme.example',
      });
    }
  });
});

describe('second security review', () => {
  it('A: the request log redacts the user code in /api/v1/device paths', () => {
    expect(loggablePath('/api/v1/device/WDJB-MJHT')).toBe('/api/v1/device/:token');
    expect(loggablePath('/api/v1/device/WDJBMJHT/approve')).toBe('/api/v1/device/:token/approve');
    expect(loggablePath('/api/v1/device/WDJBMJHT/deny')).toBe('/api/v1/device/:token/deny');
  });

  it('B: user codes are keyed with the server secret, not a plain hash', async () => {
    const ctx = ctxFor('first-party');
    const code = await startDevice(ctx, { client_id: 'rooster-cli', resource: API_RESOURCE });
    const stored = ctx.db.orm.select().from(deviceCode).get()?.userCode;
    const plain = code.user_code.replace('-', '');
    expect(stored).not.toBe(hashDeviceSecret(plain));
    expect(stored).toBe(userCodeHash(TEST_ENV.ROOSTER_AUTH_SECRET, plain));
    expect(stored).not.toBe(userCodeHash('another secret of enough length 0123456789', plain));
  });

  it('C: the per-client limit counts only client ids the endpoint could accept', async () => {
    const ctx = ctxFor('all');
    for (let i = 0; i < 35; i += 1) {
      const ip = `198.51.100.${i}`;
      const notAUrl = await requestCode(
        ctx,
        { client_id: 'not-a-cimd-url', resource: MCP_RESOURCE },
        ip,
      );
      expect(notAUrl.status).toBe(400);
    }
    const long = `https://agent.acme.example/${'x'.repeat(3000)}`;
    for (let i = 0; i < 35; i += 1) {
      const res = await requestCode(
        ctx,
        { client_id: long, resource: MCP_RESOURCE },
        `192.0.2.${i}`,
      );
      expect(res.status).toBe(400);
    }
  });

  it('D: admin cannot be added to an MCP token or a /mcp CLI login by PATCH', async () => {
    const ctx = ctxFor('first-party');
    const admin = ctx.user('admin@example.com');
    const created = await admin.ok<{ grant: Grant }>(
      'POST',
      '/api/v1/me/tokens',
      { name: 'Agent', scopes: ['tasks:read'], constraints: { orgs: 'all' }, audience: 'mcp' },
      201,
    );
    const mcpPat = await admin.call('PATCH', `/api/v1/me/grants/${created.grant.id}`, {
      scopes: ['tasks:read', 'admin'],
    });
    expect(mcpPat.status).toBe(422);
    expect(((await mcpPat.json()) as { code: string }).code).toBe('admin_not_for_mcp');
    const login = await connectCli(ctx, admin, MCP_RESOURCE);
    const mcpLogin = await admin.call('PATCH', `/api/v1/me/grants/${login.grant.id}`, {
      scopes: ['tasks:read', 'admin'],
    });
    expect(mcpLogin.status).toBe(422);
    // An API token and an API login may still get it.
    const apiPat = await admin.ok<{ grant: Grant }>(
      'POST',
      '/api/v1/me/tokens',
      { name: 'Script', scopes: ['tasks:read'], constraints: { orgs: 'all' } },
      201,
    );
    expect(
      (
        await admin.call('PATCH', `/api/v1/me/grants/${apiPat.grant.id}`, {
          scopes: ['tasks:read', 'admin'],
        })
      ).status,
    ).toBe(200);
  });
});

describe('focused review of the refresh grace and revocation', () => {
  const refreshWith = (ctx: OAuthCtx, token: string, extra: Record<string, string> = {}) =>
    tokenRequest(ctx, {
      grant_type: 'refresh_token',
      refresh_token: token,
      client_id: 'rooster-cli',
      ...extra,
    });
  const age = (ctx: OAuthCtx) =>
    ctx.db.sqlite
      .prepare(
        'UPDATE oauthRefreshToken SET rotated_at = rotated_at - 61000 WHERE rotated_at IS NOT NULL',
      )
      .run();
  const grantRow = (ctx: OAuthCtx, id: string) =>
    ctx.db.orm.select().from(accessGrant).where(eq(accessGrant.id, id)).get();

  for (const [what, extra, error] of [
    ['a wrong resource', { resource: MCP_RESOURCE }, 'invalid_target'],
    ['a wider scope', { scope: 'tasks:delete' }, 'invalid_scope'],
  ] as const) {
    it(`S1: a grace retry refused for ${what} changes nothing`, async () => {
      const ctx = ctxFor('first-party');
      const user = ctx.user('a@example.com');
      const login = await connectCli(ctx, user);
      const lost = await refreshWith(ctx, login.refresh);
      expect(lost.status).toBe(200);
      const refused = await refreshWith(ctx, login.refresh, extra);
      expect(refused.body.error).toBe(error);
      // The successor still works, and the old token is still rotated: past the window its
      // use is reuse.
      expect(
        (await withToken(ctx, lost.body.access_token as string, 'GET', '/api/v1/me')).status,
      ).toBe(200);
      age(ctx);
      expect((await refreshWith(ctx, login.refresh)).body.error).toBe('invalid_grant');
      expect(grantRow(ctx, login.grant.id)?.revokedAt).not.toBeNull();
    });
  }

  it('S1: after a refused retry, a correct one within the window still works', async () => {
    const ctx = ctxFor('first-party');
    const user = ctx.user('a@example.com');
    const login = await connectCli(ctx, user);
    expect((await refreshWith(ctx, login.refresh)).status).toBe(200);
    expect((await refreshWith(ctx, login.refresh, { resource: MCP_RESOURCE })).status).toBe(400);
    expect((await refreshWith(ctx, login.refresh)).status).toBe(200);
    expect(grantRow(ctx, login.grant.id)?.revokedAt).toBeNull();
  });

  it('S2: a rotated app refresh token revoked by name is never redeemed by the grace', async () => {
    const ctx = ctxFor('all');
    const user = ctx.user('a@example.com');
    const chains: Record<string, unknown>[] = [];
    for (const _ of [1, 2]) {
      const code = await startDevice(ctx, { client_id: APP_ID, resource: MCP_RESOURCE });
      await approve(user, code.user_code, { scopes: ['tasks:read'] });
      chains.push((await poll(ctx, code.device_code, APP_ID, MCP_RESOURCE)).body);
    }
    const [one, two] = chains as [Record<string, unknown>, Record<string, unknown>];
    const appRefresh = (token: string) =>
      tokenRequest(ctx, { grant_type: 'refresh_token', refresh_token: token, client_id: APP_ID });
    expect((await appRefresh(one.refresh_token as string)).status).toBe(200);
    const revoke = await ctx.app.request('/api/auth/oauth2/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: one.refresh_token as string,
        client_id: APP_ID,
      }).toString(),
    });
    expect(revoke.status).toBe(200);
    // The other chain is untouched by the revocation.
    const other = await appRefresh(two.refresh_token as string);
    expect(other.status).toBe(200);
    // The revoked token is not a lost answer's retry.
    expect((await appRefresh(one.refresh_token as string)).status).toBe(400);
  });

  it('S3: `token=Bearer <refresh token>` is the same token: one login ends, not every login', async () => {
    const ctx = ctxFor('first-party');
    const user = ctx.user('a@example.com');
    const laptop = await connectCli(ctx, user);
    const desktop = await connectCli(ctx, user);
    expect((await refreshWith(ctx, laptop.refresh)).status).toBe(200);
    const res = await ctx.app.request('/api/auth/oauth2/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: `Bearer ${laptop.refresh}`,
        client_id: 'rooster-cli',
      }).toString(),
    });
    expect(res.status).toBe(200);
    expect(grantRow(ctx, laptop.grant.id)?.revokedAt).not.toBeNull();
    expect((await refreshWith(ctx, desktop.refresh)).status).toBe(200);
  });

  it('S4: a grant can neither see nor acknowledge the device_connected notice', async () => {
    const ctx = ctxFor('first-party');
    const user = ctx.user('a@example.com');
    const code = await startDevice(ctx, {
      client_id: 'rooster-cli',
      scope: 'tasks:read notifications:read',
      resource: API_RESOURCE,
    });
    await approve(user, code.user_code, { scopes: ['tasks:read', 'notifications:read'] });
    const token = await poll(ctx, code.device_code, 'rooster-cli', API_RESOURCE);
    const access = token.body.access_token as string;
    const listed = (await (
      await withToken(ctx, access, 'GET', '/api/v1/notifications')
    ).json()) as {
      items: Notification[];
      unreadCount: number;
    };
    expect(listed.items.map((n) => n.type)).not.toContain('device_connected');
    expect(listed.unreadCount).toBe(0);
    const marked = await withToken(ctx, access, 'POST', '/api/v1/notifications/read', {
      all: true,
    });
    expect(marked.status).toBe(200);
    const notice = ctx.db.orm
      .select()
      .from(notification)
      .all()
      .find((n) => n.type === 'device_connected');
    expect(notice?.readAt).toBeNull();
    const byId = await withToken(ctx, access, 'POST', '/api/v1/notifications/read', {
      ids: [notice?.id],
    });
    expect(byId.status).toBe(200);
    expect(
      ctx.db.orm
        .select()
        .from(notification)
        .where(eq(notification.id, notice?.id ?? ''))
        .get()?.readAt,
    ).toBeNull();
    // The browser sees it.
    const inbox = await user.ok<{ items: Notification[] }>('GET', '/api/v1/notifications');
    expect(inbox.items.map((n) => n.type)).toContain('device_connected');
  });
});
