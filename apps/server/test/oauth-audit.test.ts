// Security audit of Phase 11 (AC-11.1), boundary 2: the OAuth consent decision (two review
// rounds). Each `it` names the finding it covers.
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { accessGrant, verification } from '../src/db/schema/index.ts';
import { hashOAuthToken } from '../src/services/oauth-grants.ts';
import { groupNamed, inboxOf } from './list-helpers.ts';
import {
  API_RESOURCE,
  allow,
  authorize,
  CLIENT_ID,
  connect,
  consentRequest,
  type OAuthCtx,
  oauthCtx,
  oauthQueryOf,
  REDIRECT_URI,
  withToken,
} from './oauth-helpers.ts';

function grantsOf(ctx: OAuthCtx, userId: string) {
  return ctx.db.orm.select().from(accessGrant).where(eq(accessGrant.userId, userId)).all();
}

/** An app connected for reading one org only, "this session only". */
async function narrowApp(ctx: OAuthCtx, email = 'ada@example.com') {
  const user = ctx.user(email);
  const inbox = await inboxOf(user);
  const narrow = { orgs: [{ orgId: inbox.orgId, read: 'all' as const, write: 'none' as const }] };
  const app = await connect(
    ctx,
    user,
    { resource: API_RESOURCE, scope: 'tasks:read' },
    { scopes: ['tasks:read'], constraints: narrow, sessionOnly: true },
  );
  const [before] = grantsOf(ctx, user.userId);
  if (before === undefined) throw new Error('no grant');
  return { user, app, before, orgId: inbox.orgId };
}

function expectUnchanged(ctx: OAuthCtx, userId: string, before: typeof accessGrant.$inferSelect) {
  const [after] = grantsOf(ctx, userId);
  expect(after?.id).toBe(before.id);
  expect(after?.scopes).toBe(before.scopes);
  expect(after?.constraints).toBe(before.constraints);
  expect(after?.expiresAt).toBe(before.expiresAt);
  expect(after?.idleTimeoutMs).toBe(before.idleTimeoutMs);
  expect(after?.revokedAt).toBeNull();
}

describe('boundary 2: the consent decision', () => {
  for (const extra of [{ prompt: 'login' }, { prompt: 'login', code: 'fake' }]) {
    it(`P1 a step-up the provider does not answer with a code leaves the grant as it was (${JSON.stringify(extra)}, overlapping)`, async () => {
      const ctx = oauthCtx();
      const { user, app, before } = await narrowApp(ctx);
      // A signed request the provider will not answer at consent: `prompt=login` was never met.
      // With `code=fake`, its login redirect reflects a `code` parameter.
      const page = await authorize(ctx, user, {
        resource: API_RESOURCE,
        scope: 'tasks:write',
        extra,
      });
      const query = new URLSearchParams(page.search);
      expect(query.get('sig')).not.toBeNull();
      const consentPage = new URL(`/oauth/consent?${query}`, page);
      const { decisionNonce } = await consentRequest(user, consentPage);
      const decide = () =>
        user.call('POST', '/api/v1/oauth/consent', {
          accept: true,
          oauthQuery: oauthQueryOf(consentPage),
          decisionNonce,
          scopes: ['tasks:write'],
          constraints: { orgs: 'all' },
        });
      const results = await Promise.all([decide(), decide()]);
      for (const res of results) expect(res.status).not.toBe(200);
      expectUnchanged(ctx, user.userId, before);
      const write = await withToken(ctx, app.access, 'POST', '/api/v1/orgs/personal/tasks', {
        title: 'Nope',
      });
      expect(write.status).toBe(403);
    });
  }

  it('P1 a step-up is written only once the code is issued, and adds to the grant as it is then', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    await connect(ctx, user, { scope: 'notifications:read' }, { scopes: ['notifications:read'] });
    const page = await authorize(ctx, user, { scope: 'tasks:write' });
    const back = await allow(user, page, { scopes: ['tasks:write'] });
    expect(back.searchParams.get('code')).not.toBeNull();
    expect(grantsOf(ctx, user.userId)[0]?.scopes).toBe('tasks:write notifications:read');
  });

  it('P1 a narrowing or revocation while the provider answers wins over the pending step-up', async () => {
    for (const change of ['narrow', 'revoke'] as const) {
      const ctx = oauthCtx();
      const { user, before, orgId } = await narrowApp(ctx);
      const page = await authorize(ctx, user, { resource: API_RESOURCE, scope: 'tasks:write' });
      const oauthQuery = oauthQueryOf(page);
      const { decisionNonce } = await consentRequest(user, page);
      const signed = new URLSearchParams(oauthQuery);
      for (const name of ['sig', 'exp', 'ba_iat', 'ba_pl', 'ba_param']) signed.delete(name);
      const grants = ctx.app.services.grants;
      const prepared = grants.applyOAuthConsent(user.actor, signed, {
        accept: true,
        oauthQuery,
        decisionNonce,
        scopes: ['tasks:write'],
        constraints: { orgs: 'all' },
      });
      // Meanwhile, in another tab: the user narrows the app further, or revokes it.
      if (change === 'narrow') {
        await user.ok('PATCH', `/api/v1/me/grants/${before.id}`, {
          constraints: {
            orgs: [{ orgId, read: { groups: [(await inboxOf(user)).id] }, write: 'none' }],
          },
          expiresInDays: 1,
        });
      } else {
        await user.ok('DELETE', `/api/v1/me/grants/${before.id}`, undefined, 204);
      }
      const [during] = grantsOf(ctx, user.userId);
      // The provider then issues a genuine code for the decision.
      const code = `audit-code-${change}`;
      ctx.db.orm
        .insert(verification)
        .values({
          id: `v-${change}`,
          identifier: hashOAuthToken(code),
          value: JSON.stringify({
            type: 'authorization_code',
            query: { client_id: CLIENT_ID, redirect_uri: REDIRECT_URI },
            userId: user.userId,
            referenceId: prepared.grantId,
          }),
          expiresAt: new Date(Date.now() + 600_000),
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .run();
      const committed = grants.finishOAuthConsent(prepared, `${REDIRECT_URI}?code=${code}&state=x`);
      expect(committed).toBe(false);
      const [after] = grantsOf(ctx, user.userId);
      expect(after).toEqual(during);
      // The code was withdrawn: it can never be redeemed.
      const left = ctx.db.orm
        .select()
        .from(verification)
        .where(eq(verification.identifier, hashOAuthToken(code)))
        .all();
      expect(left).toEqual([]);
    }
  });

  it('P1 a code is genuine only when stored for this grant, user, client and redirect URI', async () => {
    const ctx = oauthCtx();
    const { user, before } = await narrowApp(ctx);
    const page = await authorize(ctx, user, { resource: API_RESOURCE, scope: 'tasks:write' });
    const oauthQuery = oauthQueryOf(page);
    const { decisionNonce } = await consentRequest(user, page);
    const signed = new URLSearchParams(oauthQuery);
    for (const name of ['sig', 'exp', 'ba_iat', 'ba_pl', 'ba_param']) signed.delete(name);
    const grants = ctx.app.services.grants;
    const prepared = grants.applyOAuthConsent(user.actor, signed, {
      accept: true,
      oauthQuery,
      decisionNonce,
      scopes: ['tasks:write'],
      constraints: { orgs: 'all' },
    });
    for (const url of [
      `${REDIRECT_URI}?code=unknown`,
      `https://rooster.example/login?code=unknown`,
      'not a url',
    ]) {
      expect(grants.finishOAuthConsent(prepared, url)).toBe(false);
    }
    expectUnchanged(ctx, user.userId, before);
  });

  it('P1 a decision needs the nonce its own session was shown, even if that session loaded it too', async () => {
    const ctx = oauthCtx();
    const alice = ctx.user('alice@example.com');
    const bob = ctx.user('bob@example.com');
    const page = await authorize(ctx, alice, { scope: 'tasks:read' });
    // Bob's session once loaded the same request; Alice's page shows it to Alice.
    await consentRequest(bob, page);
    const { decisionNonce } = await consentRequest(alice, page);
    // The browser's cookie changes to Bob's; the page posts Alice's decision.
    for (const accept of [true, false]) {
      const res = await bob.call('POST', '/api/v1/oauth/consent', {
        accept,
        oauthQuery: oauthQueryOf(page),
        decisionNonce,
        ...(accept ? { scopes: ['tasks:read'], constraints: { orgs: 'all' } } : {}),
      });
      expect(res.status).toBe(404);
    }
    expect(grantsOf(ctx, bob.userId)).toEqual([]);
    // Another session of Alice is refused too; the session it was shown to may decide.
    const aliceAgain = ctx.signedIn(alice.userId);
    const body = {
      accept: true,
      oauthQuery: oauthQueryOf(page),
      decisionNonce,
      scopes: ['tasks:read'],
      constraints: { orgs: 'all' },
    };
    expect((await aliceAgain.call('POST', '/api/v1/oauth/consent', body)).status).toBe(404);
    expect(
      (await alice.call('POST', '/api/v1/oauth/consent', { ...body, decisionNonce: 'forged' }))
        .status,
    ).toBe(404);
    const ok = await alice.ok<{ redirectTo: string }>('POST', '/api/v1/oauth/consent', body);
    expect(new URL(ok.redirectTo).searchParams.get('code')).not.toBeNull();
  });

  it('P2 the authorization_details ceiling is enforced: narrower is fine, wider is 422', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    const prio = await groupNamed(user, 'Prio');
    const ceiling = { orgs: [{ orgId: prio.orgId, read: 'all', write: 'none' }] };
    const details = JSON.stringify([{ type: 'rooster_access', ...ceiling }]);
    const page = await authorize(ctx, user, {
      scope: 'tasks:write',
      extra: { authorization_details: details },
    });
    const request = await consentRequest(user, page);
    expect(request.prefill).toEqual(ceiling);
    for (const constraints of [
      { orgs: 'all' },
      { orgs: [{ orgId: prio.orgId, read: 'all', write: 'all' }] },
      { orgs: [{ orgId: prio.orgId, read: 'all', write: { groups: [prio.id] } }] },
    ]) {
      const res = await user.call('POST', '/api/v1/oauth/consent', {
        accept: true,
        oauthQuery: oauthQueryOf(page),
        decisionNonce: request.decisionNonce,
        scopes: ['tasks:write'],
        constraints,
      });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { code: string }).code).toBe('widening_not_allowed');
    }
    expect(grantsOf(ctx, user.userId)).toEqual([]);
    const narrower = { orgs: [{ orgId: prio.orgId, read: { groups: [prio.id] }, write: 'none' }] };
    const back = await allow(user, page, {
      scopes: ['tasks:write'],
      constraints: narrower as never,
    });
    expect(back.searchParams.get('code')).not.toBeNull();
    expect(JSON.parse(grantsOf(ctx, user.userId)[0]?.constraints ?? '{}')).toEqual(narrower);
  });

  it('P2 a ceiling that became stale fails closed; malformed details are refused', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    const prio = await groupNamed(user, 'Prio');
    const details = JSON.stringify([
      {
        type: 'rooster_access',
        orgs: [{ orgId: prio.orgId, read: { groups: [prio.id] }, write: 'none' }],
      },
    ]);
    const page = await authorize(ctx, user, {
      scope: 'tasks:write',
      extra: { authorization_details: details },
    });
    const { decisionNonce } = await consentRequest(user, page);
    // Prio goes before the user decides: the ceiling names nothing that still exists.
    await user.ok('DELETE', `/api/v1/groups/${prio.id}`, { deleteTasks: true }, 204);
    const res = await user.call('POST', '/api/v1/oauth/consent', {
      accept: true,
      oauthQuery: oauthQueryOf(page),
      decisionNonce,
      scopes: ['tasks:write'],
      constraints: { orgs: 'all' },
    });
    expect(res.status).toBe(404);
    expect(grantsOf(ctx, user.userId)).toEqual([]);
    for (const bad of [
      'not json',
      JSON.stringify({ type: 'rooster_access', orgs: 'all' }),
      JSON.stringify([{ type: 'rooster_access', orgs: 'everything' }]),
      JSON.stringify([
        { type: 'rooster_access', orgs: 'all' },
        { type: 'rooster_access', orgs: 'all' },
      ]),
    ]) {
      const p = await authorize(ctx, user, {
        scope: 'tasks:write',
        extra: { authorization_details: bad },
      });
      const shown = await user.call(
        'GET',
        `/api/v1/oauth/consent?oauth_query=${encodeURIComponent(oauthQueryOf(p))}`,
      );
      expect(shown.status, bad).toBe(404);
    }
  });
});
