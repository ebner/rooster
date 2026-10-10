// Security audit of Phase 11 (AC-11.1), boundary 2: the OAuth consent decision.
// Each `it` names the finding it covers.
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { accessGrant } from '../src/db/schema/index.ts';
import { groupNamed, inboxOf } from './list-helpers.ts';
import {
  API_RESOURCE,
  allow,
  authorize,
  connect,
  consentRequest,
  type OAuthCtx,
  oauthCtx,
  oauthQueryOf,
  withToken,
} from './oauth-helpers.ts';

function grantsOf(ctx: OAuthCtx, userId: string) {
  return ctx.db.orm.select().from(accessGrant).where(eq(accessGrant.userId, userId)).all();
}

describe('boundary 2: the consent decision', () => {
  it('P1 a step-up the provider refuses leaves the grant exactly as it was, even when two overlap', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    const inbox = await inboxOf(user);
    const narrow = { orgs: [{ orgId: inbox.orgId, read: 'all' as const, write: 'none' as const }] };
    const app = await connect(
      ctx,
      user,
      { resource: API_RESOURCE, scope: 'tasks:read' },
      { scopes: ['tasks:read'], constraints: narrow, sessionOnly: true },
    );
    const [before] = grantsOf(ctx, user.userId);
    // A signed request the provider will not answer at consent: `prompt=login` was never met.
    const page = await authorize(ctx, user, {
      resource: API_RESOURCE,
      scope: 'tasks:write',
      extra: { prompt: 'login' },
    });
    const query = new URLSearchParams(page.search);
    expect(query.get('sig')).not.toBeNull();
    const consentPage = new URL(`/oauth/consent?${query}`, page);
    await consentRequest(user, consentPage);
    const decide = () =>
      user.call('POST', '/api/v1/oauth/consent', {
        accept: true,
        oauthQuery: oauthQueryOf(consentPage),
        scopes: ['tasks:write'],
        constraints: { orgs: 'all' },
      });
    const results = await Promise.all([decide(), decide()]);
    for (const res of results) expect(res.status).not.toBe(200);
    const [after] = grantsOf(ctx, user.userId);
    expect(after?.id).toBe(before?.id);
    expect(after?.scopes).toBe(before?.scopes);
    expect(after?.constraints).toBe(before?.constraints);
    expect(after?.idleTimeoutMs).toBe(before?.idleTimeoutMs);
    expect(after?.revokedAt).toBeNull();
    // The app's token still cannot write.
    const write = await withToken(ctx, app.access, 'POST', '/api/v1/orgs/personal/tasks', {
      title: 'Nope',
    });
    expect(write.status).toBe(403);
  });

  it('P1 a step-up is written only once the code is issued, and adds to the grant as it is then', async () => {
    const ctx = oauthCtx();
    const user = ctx.user('ada@example.com');
    await connect(ctx, user, { scope: 'notifications:read' }, { scopes: ['notifications:read'] });
    const page = await authorize(ctx, user, { scope: 'tasks:write' });
    const back = await allow(user, page, { scopes: ['tasks:write'] });
    expect(back.searchParams.get('code')).not.toBeNull();
    expect(grantsOf(ctx, user.userId)[0]?.scopes).toBe('tasks:write notifications:read');
  });

  it('P1 a decision is refused from a session the request was not shown to', async () => {
    const ctx = oauthCtx();
    const alice = ctx.user('alice@example.com');
    const bob = ctx.user('bob@example.com');
    const page = await authorize(ctx, alice, { scope: 'tasks:read' });
    await consentRequest(alice, page);
    // The browser's cookie changes to Bob's; the page posts the request it showed Alice.
    for (const accept of [true, false]) {
      const res = await bob.call('POST', '/api/v1/oauth/consent', {
        accept,
        oauthQuery: oauthQueryOf(page),
        ...(accept ? { scopes: ['tasks:read'], constraints: { orgs: 'all' } } : {}),
      });
      expect(res.status).toBe(404);
    }
    expect(grantsOf(ctx, bob.userId)).toEqual([]);
    // Alice's own session that loaded it may still decide (another session of Alice may not).
    const aliceAgain = ctx.signedIn(alice.userId);
    const other = await aliceAgain.call('POST', '/api/v1/oauth/consent', {
      accept: true,
      oauthQuery: oauthQueryOf(page),
      scopes: ['tasks:read'],
      constraints: { orgs: 'all' },
    });
    expect(other.status).toBe(404);
    const ok = await alice.ok<{ redirectTo: string }>('POST', '/api/v1/oauth/consent', {
      accept: true,
      oauthQuery: oauthQueryOf(page),
      scopes: ['tasks:read'],
      constraints: { orgs: 'all' },
    });
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
});
