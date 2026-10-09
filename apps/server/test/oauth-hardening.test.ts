// WP 9.3: regressions of the first security review of the OAuth server (round 1, findings 1–9).
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import type { Grant } from '@rooster/core/schemas';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createCimdFetch } from '../src/auth/cimd-fetch.ts';
import { resolveOAuthBearer } from '../src/auth/oauth-bearer.ts';
import { accessGrant, oauthAccessToken, oauthRefreshToken } from '../src/db/schema/index.ts';
import { BASE_URL } from './helpers.ts';
import { groupNamed, inboxOf } from './list-helpers.ts';
import {
  age,
  allow,
  authorize,
  CLIENT_ID,
  connect,
  consentRequest,
  exchange,
  type OAuthCtx,
  oauthCtx,
  oauthQueryOf,
  pkce,
  refresh,
  withToken,
} from './oauth-helpers.ts';

const HOUR = 3_600_000;

const grantsOf = (ctx: OAuthCtx, userId: string) =>
  ctx.db.orm.select().from(accessGrant).where(eq(accessGrant.userId, userId)).all();

/** A refresh request with a raw form body (to send non-canonical fields). */
async function rawToken(ctx: OAuthCtx, body: string, headers: Record<string, string> = {}) {
  const res = await ctx.app.request('/api/auth/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('review round 1: token endpoint', () => {
  it('#1 a padded grant_type gets every check: idle expiry and reuse revoke the grant', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    const idle = await connect(ctx, user, {}, { sessionOnly: true });
    age(ctx, 25 * HOUR);
    const late = await rawToken(
      ctx,
      `grant_type=%20refresh_token%20&refresh_token=${idle.refresh}&client_id=${encodeURIComponent(CLIENT_ID)}`,
    );
    expect(late.status).toBe(400);
    expect(late.body.error).toBe('invalid_grant');
    expect(grantsOf(ctx, user.userId)[0]?.revokedAt).not.toBeNull();

    const other = oauthCtx();
    const bob = other.user('bob@example.com');
    const tokens = await connect(other, bob);
    expect((await refresh(other, tokens.refresh ?? '')).status).toBe(200);
    const replay = await rawToken(
      other,
      `grant_type=refresh_token%09&refresh_token=${tokens.refresh}&client_id=${encodeURIComponent(CLIENT_ID)}`,
    );
    expect(replay.body.error).toBe('invalid_grant');
    expect(grantsOf(other, bob.userId)[0]?.revokedAt).not.toBeNull();
  });

  it('#1 repeated or non-string fields are refused before the provider sees them', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    const tokens = await connect(ctx, user);
    const twice = await rawToken(
      ctx,
      `grant_type=refresh_token&refresh_token=rooster_rt_x&refresh_token=${tokens.refresh}&client_id=${encodeURIComponent(CLIENT_ID)}`,
    );
    expect(twice).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    const json = await ctx.app.request('/api/auth/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: [tokens.refresh],
        client_id: { id: CLIENT_ID },
      }),
    });
    expect(json.status).toBe(400);
    const text = await ctx.app.request('/api/auth/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'grant_type=refresh_token',
    });
    expect(text.status).toBe(400);
    // The token still works: nothing above reached the provider.
    expect((await refresh(ctx, tokens.refresh ?? '')).status).toBe(200);
  });

  it('#2 two concurrent uses of one refresh token: one wins, the other revokes the grant', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    const tokens = await connect(ctx, user);
    const results = await Promise.all([
      refresh(ctx, tokens.refresh ?? ''),
      refresh(ctx, tokens.refresh ?? ''),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(grantsOf(ctx, user.userId)[0]?.revokedAt).not.toBeNull();
    const winner = results.find((r) => r.status === 200);
    expect(
      await resolveOAuthBearer(ctx.app.services, String(winner?.body.access_token), 'mcp', null),
    ).toBeNull();
  });

  it('#3 DPoP: proofs are refused, dpop_jkt is dropped, bound tokens fail closed', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    const { verifier, challenge } = pkce();
    const page = await authorize(ctx, user, { extra: { dpop_jkt: 'A'.repeat(43) } }, challenge);
    const back = await allow(user, page);
    const code = back.searchParams.get('code') ?? '';
    const withProof = await ctx.app.request('/api/auth/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', dpop: 'eyJ.proof.sig' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: CLIENT_ID,
        redirect_uri: 'https://app.example.com/callback',
      }).toString(),
    });
    expect(withProof.status).toBe(400);
    expect(((await withProof.json()) as { error: string }).error).toBe('invalid_dpop_proof');
    // Without a proof the (unbound) code still redeems, as a bearer token.
    const plain = await exchange(ctx, code, verifier);
    expect(plain.status).toBe(200);
    expect(plain.body.token_type).toBe('Bearer');
    const access = String(plain.body.access_token);
    expect(await resolveOAuthBearer(ctx.app.services, access, 'mcp', null)).not.toBeNull();
    // A token row that is bound to a key never works as a bearer token, nor refreshes.
    const binding = JSON.stringify({ jkt: 'A'.repeat(43) });
    ctx.db.orm.update(oauthAccessToken).set({ confirmation: binding }).run();
    ctx.db.orm.update(oauthRefreshToken).set({ confirmation: binding }).run();
    expect(await resolveOAuthBearer(ctx.app.services, access, 'mcp', null)).toBeNull();
    const refreshed = await refresh(ctx, String(plain.body.refresh_token));
    expect(refreshed.body.error).toBe('invalid_grant');
  });

  it('#5 a stale refresh chain is refused alone; the grant and its active chain live on', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    const stale = await connect(ctx, user, {}, { sessionOnly: true });
    const active = await connect(ctx, user, {}, { sessionOnly: true });
    expect(active.grantId).toBe(stale.grantId);
    age(ctx, 20 * HOUR);
    const kept = await refresh(ctx, active.refresh ?? '');
    expect(kept.status).toBe(200);
    age(ctx, 5 * HOUR);
    // The first chain is 25 h old, but the grant was used 5 h ago.
    const old = await refresh(ctx, stale.refresh ?? '');
    expect(old.body.error).toBe('invalid_grant');
    expect(grantsOf(ctx, user.userId)[0]?.revokedAt).toBeNull();
    expect((await refresh(ctx, String(kept.body.refresh_token))).status).toBe(200);
  });
});

describe('review round 1: event streams', () => {
  it('#4 an OAuth stream ends when its access token expires or is revoked', async () => {
    let now = Date.now();
    const ctx = oauthCtx({ clock: () => now });
    const user = ctx.user('ada@example.com');
    const tokens = await connect(ctx, user, { resource: `${BASE_URL}/api/v1` });
    const actor = await resolveOAuthBearer(ctx.app.services, tokens.access, 'api', null);
    if (actor === null) throw new Error('actor');
    const stream = ctx.app.services.grants.streamAccess(actor);
    expect(stream.isValid()).toBe(true);
    now += 16 * 60_000;
    expect(stream.isValid()).toBe(false);

    now = Date.now();
    const second = await connect(ctx, user, { resource: `${BASE_URL}/api/v1` });
    const live = await resolveOAuthBearer(ctx.app.services, second.access, 'api', null);
    if (live === null) throw new Error('actor');
    const revocable = ctx.app.services.grants.streamAccess(live);
    expect(revocable.isValid()).toBe(true);
    const res = await ctx.app.request('/api/auth/oauth2/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: second.access,
        token_type_hint: 'access_token',
        client_id: CLIENT_ID,
      }).toString(),
    });
    expect(res.status).toBe(200);
    expect(revocable.isValid()).toBe(false);
  });
});

/** A fake https transport for the CIMD guard. */
function answering(status: number, headers: Record<string, string>) {
  return (_url: URL, _options: unknown, callback: (res: IncomingMessage) => void) => {
    const req = new EventEmitter() as ClientRequest & EventEmitter;
    const res = new PassThrough() as unknown as IncomingMessage & PassThrough;
    Object.assign(res, { statusCode: status, headers });
    req.destroy = (() => req) as ClientRequest['destroy'];
    req.end = (() => {
      queueMicrotask(() => {
        callback(res);
        res.end();
      });
      return req;
    }) as ClientRequest['end'];
    return req;
  };
}

describe('review round 1: CIMD transport', () => {
  it('#6 a 304 revalidation comes back with its cache headers, not as a redirect', async () => {
    const fetch = createCimdFetch({
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      connect: answering(304, { etag: '"v1"', 'cache-control': 'max-age=60' }),
    });
    const res = await fetch('https://app.example.com/client.json', {
      headers: { 'if-none-match': '"v1"' },
    });
    expect(res.status).toBe(304);
    expect(res.headers.get('etag')).toBe('"v1"');
    expect(res.headers.get('cache-control')).toBe('max-age=60');
  });

  it('#7 a stalling resolver is bounded by the deadline and by abort', async () => {
    const stall = () => new Promise<never>(() => {});
    const fetch = createCimdFetch({ lookup: stall, timeoutMs: 50 });
    await expect(fetch('https://app.example.com/client.json')).rejects.toThrow(/timed out/);
    const slow = createCimdFetch({ lookup: stall, timeoutMs: 60_000 });
    const controller = new AbortController();
    const pending = slow('https://app.example.com/client.json', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
  });
});

describe('review round 1: consent narrowing (8, 9)', () => {
  it('#8a approving only reading for a write request grants reading, and the token says so', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    const tokens = await connect(
      ctx,
      user,
      { scope: 'tasks:write offline_access', resource: `${BASE_URL}/api/v1` },
      { scopes: ['tasks:read'] },
    );
    expect(grantsOf(ctx, user.userId)[0]?.scopes).toBe('tasks:read');
    expect(tokens.scope).toBe('tasks:read offline_access');
    const write = await withToken(ctx, tokens.access, 'POST', '/api/v1/orgs/personal/tasks', {
      title: 'No',
    });
    expect(write.status).toBe(403);
    // A refresh reports the grant too.
    const refreshed = await refresh(ctx, tokens.refresh ?? '');
    expect(refreshed.body.scope).toBe('tasks:read offline_access');
    // The next write request asks again (the consent names only what the grant covers).
    expect((await authorize(ctx, user, { scope: 'tasks:write' })).pathname).toBe('/oauth/consent');
  });

  it('#8b a delete-only request with the box unticked grants what was approved', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    const page = await authorize(ctx, user, { scope: 'tasks:delete' });
    const back = await allow(user, page, { scopes: ['tasks:write'] });
    expect(back.searchParams.get('code')).not.toBeNull();
    expect(grantsOf(ctx, user.userId)[0]?.scopes).toBe('tasks:write');
  });

  it('#8 approving nothing the app asked for is 422 nothing_approved', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    const page = await authorize(ctx, user, { scope: 'tasks:read' });
    const res = await user.call('POST', '/api/v1/oauth/consent', {
      accept: true,
      oauthQuery: oauthQueryOf(page),
      // Neither is, nor implies, what the app asked for.
      scopes: ['admin', 'notifications:read'],
      constraints: { orgs: 'all' },
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('nothing_approved');
    expect(grantsOf(ctx, user.userId)).toEqual([]);
  });

  it('#8c step-up keeps the existing scopes', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    await connect(ctx, user, { scope: 'notifications:read' }, { scopes: ['notifications:read'] });
    const page = await authorize(ctx, user, { scope: 'tasks:write' });
    await allow(user, page, { scopes: ['tasks:read'] });
    expect(grantsOf(ctx, user.userId)[0]?.scopes).toBe('tasks:read notifications:read');
  });

  it('#9 the step-up pre-fill drops deleted groups, so it is a valid decision', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    const inbox = await inboxOf(user);
    const prio = await groupNamed(user, 'Prio');
    await connect(
      ctx,
      user,
      { scope: 'tasks:write' },
      {
        scopes: ['tasks:write'],
        constraints: {
          orgs: [
            {
              orgId: inbox.orgId,
              read: { groups: [inbox.id, prio.id] },
              write: { groups: [prio.id] },
            },
          ],
        },
      },
    );
    await user.ok('DELETE', `/api/v1/groups/${prio.id}`, { deleteTasks: true }, 204);
    const page = await authorize(ctx, user, { scope: 'tasks:write groups:write' });
    const request = await consentRequest(user, page);
    const existing = request.existing as Grant;
    expect(existing.constraints).toEqual({
      orgs: [{ orgId: inbox.orgId, read: { groups: [inbox.id] }, write: 'none' }],
    });
    const back = await allow(user, page, {
      scopes: ['tasks:write', 'groups:write'],
      constraints: existing.constraints,
    });
    expect(back.searchParams.get('code')).not.toBeNull();
  });
});

describe('review round 2', () => {
  /** A refresh with a `scope` parameter. */
  const refreshWith = (ctx: OAuthCtx, token: string, scope: string) =>
    rawToken(
      ctx,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: token,
        client_id: CLIENT_ID,
        scope,
      }).toString(),
    );

  it('#1 a refresh with exactly the advertised scope succeeds (write, and read-only narrowing)', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    const write = await connect(
      ctx,
      user,
      { scope: 'tasks:write offline_access' },
      { scopes: ['tasks:write'] },
    );
    expect(write.scope).toBe('tasks:read tasks:write offline_access');
    const again = await refreshWith(ctx, write.refresh ?? '', write.scope);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.scope).toBe(write.scope);
    // Wider than the grant: refused by rooster, the token stays usable.
    const wider = await refreshWith(ctx, String(again.body.refresh_token), 'tasks:delete');
    expect(wider).toMatchObject({ status: 400, body: { error: 'invalid_scope' } });
    expect((await refreshWith(ctx, String(again.body.refresh_token), 'admin')).body.error).toBe(
      'invalid_scope',
    );

    const other = oauthCtx();
    const bob = other.user('bob@example.com');
    const narrowed = await connect(
      other,
      bob,
      { scope: 'tasks:write offline_access' },
      { scopes: ['tasks:read'] },
    );
    expect(narrowed.scope).toBe('tasks:read offline_access');
    const ok = await refreshWith(other, narrowed.refresh ?? '', narrowed.scope);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.scope).toBe('tasks:read offline_access');
    // What the user did not approve stays out of reach, even though it was requested.
    expect(
      (await refreshWith(other, String(ok.body.refresh_token), 'tasks:write')).body.error,
    ).toBe('invalid_scope');
  });

  it('#2 a minimised step-up approval counts its implied scopes, and grants no more', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    await connect(ctx, user, { scope: 'tasks:delete' }, { scopes: ['tasks:delete'] });
    const page = await authorize(ctx, user, { scope: 'tasks:write notifications:read' });
    expect(page.pathname).toBe('/oauth/consent');
    // Notifications unticked; the web sends the minimal set, which implies writing.
    const back = await allow(user, page, { scopes: ['tasks:delete'] });
    expect(back.searchParams.get('code')).not.toBeNull();
    expect(grantsOf(ctx, user.userId)[0]?.scopes).toBe('tasks:delete');

    // Without an existing delete grant, `tasks:delete` approved for a write request grants
    // writing only.
    const fresh = oauthCtx();
    const bob = fresh.user('bob@example.com');
    const asked = await authorize(fresh, bob, { scope: 'tasks:write' });
    await allow(bob, asked, { scopes: ['tasks:delete'] });
    expect(grantsOf(fresh, bob.userId)[0]?.scopes).toBe('tasks:write');
  });
});
