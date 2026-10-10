// WP 9.3: the OAuth 2.1 authorization server (11 §4, §7, ADR 0041, ADR 0042). AC-9.3.
import type { Grant } from '@rooster/core/schemas';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { resolveOAuthBearer } from '../src/auth/oauth-bearer.ts';
import { consentHandoff, consentReferenceId } from '../src/auth/oauth-handoff.ts';
import { protectedResourceMetadata, wwwAuthenticate } from '../src/auth/oauth-metadata.ts';
import {
  accessGrant,
  activity,
  oauthAccessToken,
  oauthConsent,
  oauthRefreshToken,
  verification,
} from '../src/db/schema/index.ts';
import { IN_PROCESS_ACTOR } from '../src/lib/in-process.ts';
import { pat } from './grant-helpers.ts';
import { BASE_URL, testConfig } from './helpers.ts';
import { createTask, groupNamed, inboxOf } from './list-helpers.ts';
import {
  API_RESOURCE,
  age,
  allow,
  authorize,
  CLIENT_ID,
  connect,
  consentRequest,
  exchange,
  fakeCimd,
  ISSUER,
  MCP_RESOURCE,
  metadataDoc,
  type OAuthCtx,
  oauthCtx,
  oauthQueryOf,
  pkce,
  REDIRECT_URI,
  refresh,
  tokenRequest,
  withToken,
} from './oauth-helpers.ts';

const DAY = 86_400_000;

function grantsOf(ctx: OAuthCtx, userId: string) {
  return ctx.db.orm.select().from(accessGrant).where(eq(accessGrant.userId, userId)).all();
}

describe('AC-9.3 the authorization code flow', () => {
  it('AC-9.3 authorize → consent → code (with iss) → token bound to its grant and resource', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    const { verifier, challenge } = pkce();
    const page = await authorize(ctx, user, { scope: 'tasks:write offline_access' }, challenge);
    expect(`${page.origin}${page.pathname}`).toBe(`${BASE_URL}/oauth/consent`);

    const request = await consentRequest(user, page);
    expect(request).toMatchObject({
      clientId: CLIENT_ID,
      client: { name: 'Example App', domain: 'app.example.com', verified: true, dynamic: false },
      redirectUri: REDIRECT_URI,
      loopback: false,
      resource: MCP_RESOURCE,
      requestedScopes: ['tasks:write'],
      newScopes: [],
      existing: null,
      prefill: null,
    });

    const back = await allow(user, page, { scopes: ['tasks:write'], expiresInDays: 30 });
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT_URI);
    expect(back.searchParams.get('state')).toBe('xyz');
    expect(back.searchParams.get('iss')).toBe(ISSUER);
    const token = await exchange(ctx, back.searchParams.get('code') ?? '', verifier);
    expect(token.status).toBe(200);
    expect(token.body).toMatchObject({ token_type: 'Bearer', expires_in: 900 });
    expect(token.body.access_token).toMatch(/^rooster_at_/);
    expect(token.body.refresh_token).toMatch(/^rooster_rt_/);
    // The response reports what the grant allows, implied scopes spelled out.
    expect(token.body.scope).toBe('tasks:read tasks:write offline_access');

    // The grant handoff: every token, the consent and the grant agree (ADR 0041 §1).
    const [grant] = grantsOf(ctx, user.userId);
    expect(grant).toMatchObject({ kind: 'oauth', clientId: CLIENT_ID, label: 'Example App' });
    expect(grant?.expiresAt).toBeGreaterThan(Date.now() + 29 * DAY);
    for (const table of [oauthAccessToken, oauthRefreshToken, oauthConsent]) {
      const rows = ctx.db.orm.select({ ref: table.referenceId }).from(table).all();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.ref === grant?.id)).toBe(true);
    }
    // Stored hashed: the plain token is nowhere in the database.
    const stored = ctx.db.orm.select().from(oauthAccessToken).all();
    expect(stored.some((r) => String(token.body.access_token).includes(r.token ?? '-'))).toBe(
      false,
    );

    const actor = await resolveOAuthBearer(
      ctx.app.services,
      String(token.body.access_token),
      'mcp',
      '203.0.113.9',
    );
    expect(actor).toMatchObject({
      userId: user.userId,
      via: 'oauth',
      grant: { id: grant?.id, kind: 'oauth', scopes: ['tasks:write'], resource: 'mcp' },
    });
    const listed = await user.ok<Grant[]>('GET', '/api/v1/me/grants');
    expect(listed[0]).toMatchObject({
      kind: 'oauth',
      idleTimeoutMs: null,
      lastUsedIp: '203.0.113.9',
      client: { name: 'Example App', domain: 'app.example.com', verified: true, dynamic: false },
    });
  });

  it('a token is accepted only by its own resource (11 §4.3)', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    const mcp = await connect(ctx, user, { resource: MCP_RESOURCE });
    const api = await connect(ctx, user, { resource: API_RESOURCE });
    const services = ctx.app.services;
    expect(await resolveOAuthBearer(services, mcp.access, 'mcp', null)).not.toBeNull();
    expect(await resolveOAuthBearer(services, mcp.access, 'api', null)).toBeNull();
    expect(await resolveOAuthBearer(services, api.access, 'api', null)).not.toBeNull();
    expect(await resolveOAuthBearer(services, api.access, 'mcp', null)).toBeNull();

    const wrong = await withToken(ctx, mcp.access, 'GET', '/api/v1/me');
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('www-authenticate')).toBe(
      `Bearer error="invalid_token", scope="tasks:read", resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource/api/v1"`,
    );
    const right = await withToken(ctx, api.access, 'GET', '/api/v1/me');
    expect(right.status).toBe(200);
    // Both resources were consented for the one grant: no second grant.
    expect(grantsOf(ctx, user.userId)).toHaveLength(1);
    expect(await resolveOAuthBearer(services, `${api.access}x`, 'api', null)).toBeNull();
    expect(await resolveOAuthBearer(services, 'rooster_pat_x', 'api', null)).toBeNull();
  });

  it('enforces the grant’s scopes and constraints on /api/v1, read on every request', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    const inbox = await inboxOf(user);
    const prio = await groupNamed(user, 'Prio');
    const orgId = inbox.orgId;
    const tokens = await connect(
      ctx,
      user,
      { resource: API_RESOURCE, scope: 'tasks:write' },
      {
        scopes: ['tasks:write'],
        constraints: { orgs: [{ orgId, read: 'all', write: { groups: [inbox.id] } }] },
      },
    );
    const ok = await withToken(ctx, tokens.access, 'POST', '/api/v1/orgs/personal/tasks', {
      title: 'Via app',
    });
    expect(ok.status).toBe(201);
    const outside = await withToken(ctx, tokens.access, 'POST', '/api/v1/orgs/personal/tasks', {
      title: 'Prio task',
      groupId: prio.id,
    });
    expect(outside.status).toBe(403);
    expect(((await outside.json()) as { code: string }).code).toBe('outside_grant');
    const comment = await createTask(user, { title: 'Mine' });
    const denied = await withToken(
      ctx,
      tokens.access,
      'POST',
      `/api/v1/tasks/${comment.id}/comments`,
      {
        body: 'hi',
      },
    );
    expect(denied.status).toBe(403);
    // Narrowing in Connected apps applies on the next request.
    await user.ok('PATCH', `/api/v1/me/grants/${tokens.grantId}`, { scopes: ['tasks:read'] });
    const narrowed = await withToken(ctx, tokens.access, 'POST', '/api/v1/orgs/personal/tasks', {
      title: 'Again',
    });
    expect(narrowed.status).toBe(403);
  });

  it('records via: oauth on /api/v1 and via: mcp for the in-process MCP actor (11 §2.3)', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    const api = await connect(
      ctx,
      user,
      { resource: API_RESOURCE, scope: 'tasks:write' },
      {
        scopes: ['tasks:write'],
      },
    );
    const created = await withToken(ctx, api.access, 'POST', '/api/v1/orgs/personal/tasks', {
      title: 'Through the API',
    });
    expect(created.status).toBe(201);
    const mcp = await connect(
      ctx,
      user,
      { resource: MCP_RESOURCE, scope: 'tasks:write' },
      {
        scopes: ['tasks:write'],
      },
    );
    const actor = await resolveOAuthBearer(ctx.app.services, mcp.access, 'mcp', null);
    const res = await ctx.app.fetch(
      new Request(`${BASE_URL}/api/v1/orgs/personal/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rooster-client': 'mcp/0.0.0' },
        body: JSON.stringify({ title: 'Through MCP' }),
      }),
      { [IN_PROCESS_ACTOR]: actor },
    );
    expect(res.status, await res.clone().text()).toBe(201);
    const vias = ctx.db.orm
      .select({ data: activity.data })
      .from(activity)
      .all()
      .map((r) => JSON.parse(r.data) as { via: string; grantId?: string });
    expect(vias).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ via: 'oauth', grantId: api.grantId }),
        expect.objectContaining({ via: 'mcp', grantId: mcp.grantId }),
      ]),
    );
  });

  it('a repeat authorization within the grant skips the consent screen', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    await connect(ctx, user, { scope: 'tasks:write offline_access' }, { scopes: ['tasks:write'] });
    // tasks:read is implied by the grant's tasks:write.
    for (const scope of ['tasks:write offline_access', 'tasks:read']) {
      const back = await authorize(ctx, user, { scope });
      expect(back.pathname).toBe('/callback');
      expect(back.searchParams.get('code')).not.toBeNull();
      expect(back.searchParams.get('iss')).toBe(ISSUER);
    }
  });

  it('step-up shows the new scopes with the existing grant, and keeps the grant', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    const inbox = await inboxOf(user);
    const constraints = {
      orgs: [{ orgId: inbox.orgId, read: 'all' as const, write: 'none' as const }],
    };
    const first = await connect(
      ctx,
      user,
      { scope: 'tasks:read notifications:read' },
      {
        scopes: ['tasks:read', 'notifications:read'],
        constraints,
      },
    );
    const page = await authorize(ctx, user, { scope: 'tasks:write' });
    expect(page.pathname).toBe('/oauth/consent');
    const request = await consentRequest(user, page);
    expect(request.newScopes).toEqual(['tasks:write']);
    expect(request.existing).toMatchObject({ id: first.grantId, constraints });
    const back = await allow(user, page, {
      scopes: ['tasks:write'],
      constraints: { orgs: [{ orgId: inbox.orgId, read: 'all', write: { groups: [inbox.id] } }] },
    });
    expect(back.searchParams.get('code')).not.toBeNull();
    const grants = grantsOf(ctx, user.userId);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.id).toBe(first.grantId);
    expect(grants[0]?.scopes.split(' ').sort()).toEqual(['notifications:read', 'tasks:write']);
  });

  it('narrowing an app in Connected apps makes a wider request show the consent again', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    const first = await connect(ctx, user, { scope: 'tasks:write' }, { scopes: ['tasks:write'] });
    await user.ok('PATCH', `/api/v1/me/grants/${first.grantId}`, { scopes: ['tasks:read'] });
    expect((await authorize(ctx, user, { scope: 'tasks:read' })).pathname).toBe('/callback');
    expect((await authorize(ctx, user, { scope: 'tasks:write' })).pathname).toBe('/oauth/consent');
    // Widening an app outside the consent screen is refused.
    const widen = await user.call('PATCH', `/api/v1/me/grants/${first.grantId}`, {
      scopes: ['tasks:write'],
    });
    expect(widen.status).toBe(422);
  });

  it('deny answers access_denied with iss, and creates no grant', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    const page = await authorize(ctx, user);
    const { decisionNonce } = await consentRequest(user, page);
    const { redirectTo } = await user.ok<{ redirectTo: string }>('POST', '/api/v1/oauth/consent', {
      accept: false,
      oauthQuery: oauthQueryOf(page),
      decisionNonce,
    });
    const back = new URL(redirectTo);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT_URI);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe('xyz');
    expect(back.searchParams.get('iss')).toBe(ISSUER);
    expect(grantsOf(ctx, user.userId)).toEqual([]);
  });

  it('a tampered or unsigned oauth_query is 404, and only the browser may consent', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    const page = await authorize(ctx, user);
    const query = oauthQueryOf(page);
    const tampered = query.replace('scope=tasks%3Aread', 'scope=tasks%3Adelete');
    for (const q of [tampered, `${query}&scope=tasks%3Adelete`, 'client_id=x&sig=abc']) {
      const res = await user.call(
        'GET',
        `/api/v1/oauth/consent?oauth_query=${encodeURIComponent(q)}`,
      );
      expect(res.status).toBe(404);
      const post = await user.call('POST', '/api/v1/oauth/consent', {
        accept: true,
        oauthQuery: q,
        decisionNonce: 'x',
        scopes: ['tasks:read'],
        constraints: { orgs: 'all' },
      });
      expect(post.status).toBe(404);
    }
    const token = await pat(user, ['tasks:read']);
    const viaPat = await withToken(
      ctx,
      token.token,
      'GET',
      `/api/v1/oauth/consent?oauth_query=${encodeURIComponent(query)}`,
    );
    expect(viaPat.status).toBe(403);
    expect(grantsOf(ctx, user.userId).filter((g) => g.kind === 'oauth')).toEqual([]);
  });

  it('AC-9.3 "This session only" ends the grant after a day without a refresh', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    const tokens = await connect(ctx, user, {}, { sessionOnly: true, expiresInDays: 7 });
    const [grant] = grantsOf(ctx, user.userId);
    expect(grant).toMatchObject({ idleTimeoutMs: 86_400_000, expiresAt: null });
    // Used within the day: still alive, and each refresh restarts the day.
    age(ctx, 20 * 3_600_000);
    const first = await refresh(ctx, tokens.refresh ?? '');
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    age(ctx, 20 * 3_600_000);
    const second = await refresh(ctx, String(first.body.refresh_token));
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    // Then a day and more of silence.
    age(ctx, 25 * 3_600_000);
    const late = await refresh(ctx, String(second.body.refresh_token));
    expect(late.status).toBe(400);
    expect(late.body.error).toBe('invalid_grant');
    expect(grantsOf(ctx, user.userId)[0]?.revokedAt).not.toBeNull();
    expect(ctx.db.orm.select().from(oauthRefreshToken).all()).toEqual([]);
    // A grant that expires by date is not idle-limited.
    const dated = await connect(ctx, user, {}, { expiresInDays: 7 });
    age(ctx, 3 * DAY);
    expect((await refresh(ctx, dated.refresh ?? '')).status).toBe(200);
  });
});

describe('OAuth conformance (11 §7)', () => {
  it('PKCE is required, and only S256', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    const missing = await authorize(ctx, user, { challenge: null });
    expect(missing.searchParams.get('error')).toBe('invalid_request');
    expect(missing.searchParams.get('iss')).toBe(ISSUER);
    const plain = await authorize(ctx, user, { method: 'plain' });
    expect(plain.searchParams.get('error')).toBe('invalid_request');
    expect(plain.searchParams.get('iss')).toBe(ISSUER);
    // A wrong verifier fails at the token endpoint.
    const { challenge } = pkce();
    const page = await authorize(ctx, user, {}, challenge);
    const back = await allow(user, page);
    const token = await exchange(ctx, back.searchParams.get('code') ?? '', pkce().verifier);
    expect(token.status).toBeGreaterThanOrEqual(400);
    expect(token.body.access_token).toBeUndefined();
  });

  it('openid is never offered: invalid_scope, and no OIDC discovery', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    const back = await authorize(ctx, user, {
      scope: 'openid tasks:read',
      challenge: null,
      extra: { nonce: 'n' },
    });
    expect(back.searchParams.get('error')).toBe('invalid_scope');
    expect(back.searchParams.get('iss')).toBe(ISSUER);
    const meta = (await (
      await ctx.app.request('/.well-known/oauth-authorization-server/api/auth')
    ).json()) as { scopes_supported: string[] };
    expect(meta.scopes_supported).not.toContain('openid');
    for (const path of [
      '/api/auth/.well-known/openid-configuration',
      '/.well-known/openid-configuration/api/auth',
    ]) {
      expect((await ctx.app.request(path)).status).toBe(404);
    }
  });

  it('admin is never available to apps (invalid_scope), nor through the decision', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('admin@example.com');
    const back = await authorize(ctx, user, { scope: 'admin tasks:read' });
    expect(back.searchParams.get('error')).toBe('invalid_scope');
    const page = await authorize(ctx, user, { scope: 'tasks:read' });
    const { decisionNonce } = await consentRequest(user, page);
    const res = await user.call('POST', '/api/v1/oauth/consent', {
      accept: true,
      oauthQuery: oauthQueryOf(page),
      decisionNonce,
      scopes: ['admin', 'tasks:read'],
      constraints: { orgs: 'all' },
    });
    expect(res.status).toBe(200);
    expect(grantsOf(ctx, user.userId)[0]?.scopes).toBe('tasks:read');
  });

  it('resource is required, single, and one of rooster’s (invalid_target with iss)', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    for (const resource of [
      null,
      [MCP_RESOURCE, API_RESOURCE],
      'https://evil.example/api',
      `${BASE_URL}/api/v2`,
    ]) {
      const back = await authorize(ctx, user, { resource });
      expect(`${back.origin}${back.pathname}`, JSON.stringify(resource)).toBe(REDIRECT_URI);
      expect(back.searchParams.get('error')).toBe('invalid_target');
      expect(back.searchParams.get('state')).toBe('xyz');
      expect(back.searchParams.get('iss')).toBe(ISSUER);
    }
    // At the token endpoint: another resource than authorized, or two.
    for (const resource of [API_RESOURCE, [MCP_RESOURCE, API_RESOURCE]]) {
      const { verifier, challenge } = pkce();
      const page = await authorize(ctx, user, {}, challenge);
      const back = page.pathname === '/oauth/consent' ? await allow(user, page) : page;
      const token = await exchange(ctx, back.searchParams.get('code') ?? '', verifier, {
        resource,
      });
      expect(token.status).toBe(400);
      expect(token.body.error).toBe('invalid_target');
    }
  });

  it('refresh tokens rotate, and a reused one revokes the whole grant', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    const tokens = await connect(ctx, user);
    const rotated = await refresh(ctx, tokens.refresh ?? '');
    expect(rotated.status).toBe(200);
    expect(rotated.body.refresh_token).not.toBe(tokens.refresh);
    const newAccess = String(rotated.body.access_token);
    expect(await resolveOAuthBearer(ctx.app.services, newAccess, 'mcp', null)).not.toBeNull();
    // The old one again: reuse.
    const reused = await refresh(ctx, tokens.refresh ?? '');
    expect(reused.status).toBe(400);
    expect(reused.body.error).toBe('invalid_grant');
    expect(grantsOf(ctx, user.userId)[0]?.revokedAt).not.toBeNull();
    expect(await resolveOAuthBearer(ctx.app.services, newAccess, 'mcp', null)).toBeNull();
    const next = await refresh(ctx, String(rotated.body.refresh_token));
    expect(next.status).toBe(400);
    for (const table of [oauthAccessToken, oauthRefreshToken, oauthConsent]) {
      expect(ctx.db.orm.select().from(table).all()).toEqual([]);
    }
    // The next authorization asks again and makes a new grant.
    expect((await authorize(ctx, user)).pathname).toBe('/oauth/consent');
  });

  it('revoking in Connected apps kills the tokens and the consent', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    const tokens = await connect(ctx, user, { resource: API_RESOURCE });
    // A code issued but not yet redeemed dies with it too.
    const { verifier, challenge } = pkce();
    const pending = await authorize(ctx, user, { resource: API_RESOURCE }, challenge);
    expect(pending.searchParams.get('code')).not.toBeNull();
    await user.ok('DELETE', `/api/v1/me/grants/${tokens.grantId}`, undefined, 204);
    expect((await withToken(ctx, tokens.access, 'GET', '/api/v1/me')).status).toBe(401);
    const again = await refresh(ctx, tokens.refresh ?? '');
    expect(again.body.error).toBe('invalid_grant');
    const late = await exchange(ctx, pending.searchParams.get('code') ?? '', verifier);
    expect(late.status).toBe(400);
    expect(ctx.db.orm.select().from(oauthConsent).all()).toEqual([]);
    expect((await authorize(ctx, user, { resource: API_RESOURCE })).pathname).toBe(
      '/oauth/consent',
    );
  });

  it('an expired grant or a disabled user ends the tokens', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    const tokens = await connect(ctx, user, { resource: API_RESOURCE });
    ctx.db.orm
      .update(accessGrant)
      .set({ expiresAt: 1 })
      .where(eq(accessGrant.id, tokens.grantId))
      .run();
    expect((await withToken(ctx, tokens.access, 'GET', '/api/v1/me')).status).toBe(401);
    expect((await refresh(ctx, tokens.refresh ?? '')).body.error).toBe('invalid_grant');
    // A new consent replaces the expired grant (one live grant per user and app).
    const fresh = await connect(ctx, user, { resource: API_RESOURCE });
    expect(fresh.grantId).not.toBe(tokens.grantId);
    expect((await withToken(ctx, fresh.access, 'GET', '/api/v1/me')).status).toBe(200);
    const { user: users } = await import('../src/db/schema/index.ts');
    ctx.db.orm.update(users).set({ disabledAt: Date.now() }).where(eq(users.id, user.userId)).run();
    expect((await withToken(ctx, fresh.access, 'GET', '/api/v1/me')).status).toBe(401);
  });

  it('the grant handoff never yields a code or token without a grant', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    const { verifier, challenge } = pkce();
    const page = await authorize(ctx, user, {}, challenge);
    const back = await allow(user, page);
    const code = back.searchParams.get('code') ?? '';
    // Strip the grant from the stored code: the token endpoint refuses it.
    for (const row of ctx.db.orm.select().from(verification).all()) {
      const value = JSON.parse(row.value) as Record<string, unknown>;
      if (value.type !== 'authorization_code') continue;
      expect(value.referenceId).toBe(grantsOf(ctx, user.userId)[0]?.id);
      delete value.referenceId;
      ctx.db.orm
        .update(verification)
        .set({ value: JSON.stringify(value) })
        .where(eq(verification.id, row.id))
        .run();
    }
    const token = await exchange(ctx, code, verifier);
    expect(token.status).toBe(400);
    expect(token.body.error).toBe('invalid_grant');
    expect(ctx.db.orm.select().from(oauthAccessToken).all()).toEqual([]);

    // The explicit handoff must name the request's user and client.
    await expect(
      consentHandoff.run({ userId: 'someone-else', clientId: CLIENT_ID, grantId: 'g' }, () =>
        consentReferenceId('ada', () => null),
      ),
    ).rejects.toThrow();
  });

  it('client-side endpoints ignore cookies and bearer credentials; the rest are not served', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    const token = await pat(user, ['tasks:read']);
    // A browser session cannot register a client, nor turn into one at the token endpoint.
    const bogus = await ctx.app.request('/api/auth/oauth2/token', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token.token}`,
        cookie: user.jar.header(),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=refresh_token&refresh_token=rooster_rt_nope&client_id=x',
    });
    expect(bogus.status).toBe(400);
    for (const path of [
      '/api/auth/oauth2/introspect',
      '/api/auth/oauth2/userinfo',
      '/api/auth/oauth2/consent',
      '/api/auth/oauth2/continue',
      '/api/auth/oauth2/get-consents',
      '/api/auth/oauth2/create-client',
      '/api/auth/oauth2/end-session',
      '/api/auth/admin/oauth2/resources',
      '/api/auth/.well-known/oauth-authorization-server',
    ]) {
      const res = await ctx.app.request(path, {
        method: 'POST',
        headers: {
          cookie: user.jar.header(),
          origin: BASE_URL,
          'content-type': 'application/json',
        },
        body: '{}',
      });
      expect(res.status, path).toBe(404);
    }
    // client_credentials is not a grant type here.
    const m2m = await tokenRequest(ctx, { grant_type: 'client_credentials', client_id: CLIENT_ID });
    expect(m2m.status).toBe(400);
  });
});

describe('client registration (11 §4.2)', () => {
  it('DCR is off by default', async () => {
    const ctx = oauthCtx();
    const res = await ctx.app.request('/api/auth/oauth2/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:8123/cb'], client_name: 'Old' }),
    });
    expect(res.status).toBe(403);
    const meta = (await (
      await ctx.app.request('/.well-known/oauth-authorization-server/api/auth')
    ).json()) as Record<string, unknown>;
    expect(meta.registration_endpoint).toBeUndefined();
  });

  it('with ROOSTER_OAUTH_DCR=on, a registered client is an unverified app; a loopback redirect is "this computer"', async () => {
    const ctx = oauthCtx({ env: { ROOSTER_OAUTH_DCR: 'on' } });
    const user = ctx.user('ada@example.com');
    const res = await ctx.app.request('/api/auth/oauth2/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: user.jar.header() },
      body: JSON.stringify({
        redirect_uris: ['http://127.0.0.1:8123/cb'],
        client_name: 'Old client',
        token_endpoint_auth_method: 'none',
        application_type: 'native',
        skip_consent: true,
      }),
    });
    expect(res.status).toBe(400);
    const ok = await ctx.app.request('/api/auth/oauth2/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: user.jar.header() },
      body: JSON.stringify({
        redirect_uris: ['http://127.0.0.1:8123/cb'],
        client_name: 'Old client',
        token_endpoint_auth_method: 'none',
        application_type: 'native',
      }),
    });
    expect(ok.status, await ok.clone().text()).toBe(201);
    const { client_id: clientId } = (await ok.json()) as { client_id: string };
    // The browser session did not make the client theirs: anonymous registration.
    const page = await authorize(ctx, user, {
      clientId,
      redirectUri: 'http://127.0.0.1:9999/cb',
    });
    expect(page.pathname).toBe('/oauth/consent');
    const request = await consentRequest(user, page);
    expect(request).toMatchObject({
      loopback: true,
      client: { name: 'Old client', domain: '127.0.0.1', verified: false, dynamic: true },
    });
    const meta = (await (
      await ctx.app.request('/.well-known/oauth-authorization-server/api/auth')
    ).json()) as Record<string, unknown>;
    expect(meta.registration_endpoint).toBe(`${ISSUER}/oauth2/register`);
  });

  it('a native CIMD client may use a loopback redirect on any port ("an app on this computer")', async () => {
    const clientId = 'https://desktop.example.net/client.json';
    const cimd = fakeCimd({
      [clientId]: metadataDoc(clientId, {
        application_type: 'native',
        redirect_uris: ['http://127.0.0.1/callback'],
      }),
    });
    const ctx = oauthCtx({ cimd });
    const user = ctx.user('ada@example.com');
    const page = await authorize(ctx, user, {
      clientId,
      redirectUri: 'http://127.0.0.1:53682/callback',
    });
    expect(page.pathname).toBe('/oauth/consent');
    const request = await consentRequest(user, page);
    expect(request).toMatchObject({
      loopback: true,
      redirectUri: 'http://127.0.0.1:53682/callback',
      client: { domain: 'desktop.example.net', verified: false, dynamic: false },
    });
    const back = await allow(user, page);
    expect(back.origin).toBe('http://127.0.0.1:53682');
    expect(back.searchParams.get('code')).not.toBeNull();
  });

  it('a CIMD client is unverified when its redirect host differs from its metadata host', async () => {
    const clientId = 'https://tools.example.net/client.json';
    const cimd = fakeCimd({
      [clientId]: metadataDoc(clientId, { redirect_uris: ['https://callback.example.org/cb'] }),
    });
    const ctx = oauthCtx({ cimd });
    const user = ctx.user('ada@example.com');
    const page = await authorize(ctx, user, {
      clientId,
      redirectUri: 'https://callback.example.org/cb',
    });
    const request = await consentRequest(user, page);
    expect(request.client).toMatchObject({
      domain: 'tools.example.net',
      verified: false,
      dynamic: false,
    });
    // An unregistered redirect URI is never followed.
    const wrong = await authorize(ctx, user, { clientId, redirectUri: 'https://evil.example/cb' });
    expect(wrong.origin).toBe(BASE_URL);
    expect(wrong.searchParams.get('error')).toBe('invalid_redirect');
  });
});

describe('tasks:delete only by explicit consent (ADR 0041 §2, ADR 0042 §4)', () => {
  it('needs both the request and the decision; authorization_details pre-fill never ticks it', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    const inbox = await inboxOf(user);
    const details = JSON.stringify([
      {
        type: 'rooster_access',
        orgs: [{ orgId: inbox.orgId, read: 'all', write: { groups: [inbox.id] } }],
        scopes: ['tasks:delete'],
      },
    ]);
    const page = await authorize(ctx, user, {
      scope: 'tasks:write tasks:delete',
      extra: { authorization_details: details },
    });
    const request = await consentRequest(user, page);
    expect(request.requestedScopes).toEqual(['tasks:write', 'tasks:delete']);
    expect(request.prefill).toEqual({
      orgs: [{ orgId: inbox.orgId, read: 'all', write: { groups: [inbox.id] } }],
    });
    // Unticked: no delete. The pre-fill is also the ceiling of the constraints.
    const back = await allow(user, page, {
      scopes: ['tasks:write'],
      constraints: request.prefill ?? { orgs: 'all' },
    });
    expect(back.searchParams.get('code')).not.toBeNull();
    expect(grantsOf(ctx, user.userId)[0]?.scopes).toBe('tasks:write');

    // Ticked without the client asking: still none.
    const other = await authorize(ctx, user, {
      clientId: CLIENT_ID,
      scope: 'tasks:write notifications:read',
    });
    await allow(user, other, { scopes: ['tasks:write', 'tasks:delete', 'notifications:read'] });
    expect(grantsOf(ctx, user.userId)[0]?.scopes).not.toContain('tasks:delete');

    // Requested and ticked.
    const asked = await authorize(ctx, user, { scope: 'tasks:delete' });
    expect(asked.pathname).toBe('/oauth/consent');
    await allow(user, asked, { scopes: ['tasks:delete'] });
    expect(grantsOf(ctx, user.userId)[0]?.scopes).toContain('tasks:delete');
  });

  it('refuses a pre-fill that names only foreign orgs (a ceiling never reads as absent)', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    const details = JSON.stringify([
      {
        type: 'rooster_access',
        orgs: [{ orgId: '0199a1b2-0000-7000-8000-000000000001', read: 'all', write: 'all' }],
      },
    ]);
    const page = await authorize(ctx, user, { extra: { authorization_details: details } });
    const res = await user.call(
      'GET',
      `/api/v1/oauth/consent?oauth_query=${encodeURIComponent(oauthQueryOf(page))}`,
    );
    expect(res.status).toBe(404);
  });
});

describe('discovery documents (RFC 8414, RFC 9728)', () => {
  it('serves the authorization server metadata at the path-inserted URL', async () => {
    const ctx = oauthCtx();
    const res = await ctx.app.request('/.well-known/oauth-authorization-server/api/auth');
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth2/authorize`,
      token_endpoint: `${ISSUER}/oauth2/token`,
      revocation_endpoint: `${ISSUER}/oauth2/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
    });
    for (const key of Object.keys(meta)) {
      expect(key).not.toMatch(/introspection|dpop|backchannel|jwks|userinfo|end_session/);
    }
    expect(meta.scopes_supported).toEqual([
      'tasks:read',
      'tasks:write',
      'comments:write',
      'tasks:assign',
      'groups:write',
      'tasks:delete',
      'notifications:read',
      'offline_access',
    ]);
  });

  it('serves the /api/v1 protected resource metadata, and the helpers the MCP endpoint uses', async () => {
    const ctx = oauthCtx();
    const res = await ctx.app.request('/.well-known/oauth-protected-resource/api/v1');
    expect(await res.json()).toEqual({
      resource: API_RESOURCE,
      authorization_servers: [ISSUER],
      scopes_supported: ['tasks:read'],
      bearer_methods_supported: ['header'],
      resource_name: 'rooster',
    });
    const config = testConfig();
    expect(protectedResourceMetadata(config, 'mcp').resource).toBe(MCP_RESOURCE);
    expect(wwwAuthenticate(config, 'mcp', { scope: 'tasks:read' })).toBe(
      `Bearer scope="tasks:read", resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource/mcp"`,
    );
    expect(
      wwwAuthenticate(config, 'mcp', {
        error: 'insufficient_scope',
        scope: ['tasks:read', 'tasks:write'],
      }),
    ).toBe(
      `Bearer error="insufficient_scope", scope="tasks:read tasks:write", resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource/mcp"`,
    );
  });
});

describe('signing in during an authorization', () => {
  it('sends a signed-out browser to /login, and the same query resumes the authorization', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    const login = await authorize(ctx, null);
    expect(`${login.origin}${login.pathname}`).toBe(`${BASE_URL}/login`);
    expect(login.searchParams.get('sig')).not.toBeNull();
    expect(login.searchParams.get('client_id')).toBe(CLIENT_ID);
    // After signing in, the SPA sends the browser back to authorize with that query.
    const res = await ctx.app.request(`/api/auth/oauth2/authorize${login.search}`, {
      headers: { cookie: user.jar.header() },
    });
    const page = new URL(res.headers.get('location') ?? '', BASE_URL);
    expect(page.pathname).toBe('/oauth/consent');
    const back = await allow(user, page);
    expect(back.searchParams.get('code')).not.toBeNull();
  });
});
