import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from '../src/app.ts';
import { INVITE_COOKIE, SESSION_COOKIE } from '../src/auth/cookies.ts';
import type { AppDb } from '../src/db/client.ts';
import { account, organization, session, taskGroup, user } from '../src/db/schema/index.ts';
import {
  asJar,
  BASE_URL,
  CookieJar,
  createTestApp,
  idpEnv,
  jsonBody,
  signInAs,
} from './helpers.ts';
import { type MockIdp, startMockIdp } from './mock-idp.ts';

let idp: MockIdp;

beforeAll(async () => {
  idp = await startMockIdp();
});
afterAll(async () => {
  await idp.stop();
});

function appWith(env: Record<string, string> = {}): { app: App; db: AppDb } {
  return createTestApp({ env: { ...idpEnv(idp), ...env } });
}

function users(db: AppDb) {
  return db.orm.select().from(user).all();
}

function providerIds(db: AppDb): string[] {
  return db.orm
    .select({ providerId: account.providerId })
    .from(account)
    .all()
    .map((a) => a.providerId)
    .sort();
}

function groupNames(db: AppDb, userId: string, orgId: string): string[] {
  return db.orm
    .select({ name: taskGroup.name, kind: taskGroup.kind, position: taskGroup.position })
    .from(taskGroup)
    .where(and(eq(taskGroup.userId, userId), eq(taskGroup.orgId, orgId)))
    .all()
    .sort((a, b) =>
      a.kind === b.kind ? (a.position < b.position ? -1 : 1) : a.kind === 'inbox' ? -1 : 1,
    )
    .map((g) => g.name);
}

describe('sign-in through the mock IdP', () => {
  it('admin signs in, gets the rooster.session cookie and reaches /api/v1/me', async () => {
    const { app } = appWith();
    const { jar, location } = await signInAs(app, 'admin@example.com');
    expect(location).toBe('/');
    expect(jar.get(SESSION_COOKIE)).toBeDefined();
    const me = await app.request('/api/v1/me', asJar(jar));
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: 'admin@example.com', isAdmin: true });
  });

  it('sets the session cookie httpOnly, SameSite=Lax, 30 days, not Secure on http', async () => {
    const { app } = appWith();
    const start = await app.request('/api/auth/sign-in/social', {
      ...jsonBody('POST', { provider: 'dev', callbackURL: '/', loginHint: 'admin@example.com' }),
      headers: { 'content-type': 'application/json', origin: BASE_URL },
    });
    const jar = new CookieJar().update(start);
    const { url } = (await start.json()) as { url: string };
    const callback = new URL(
      (await fetch(url, { redirect: 'manual' })).headers.get('location') ?? '',
    );
    const done = await app.request(`${callback.pathname}${callback.search}`, {
      headers: { cookie: jar.header() },
    });
    const cookie = done.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Max-Age=2592000/);
    expect(cookie).not.toMatch(/Secure/i);
  });

  it('AC-1.1 rejects a user who is not on the allowlist: /not-invited and no user row', async () => {
    const { app, db } = appWith();
    const { jar, location } = await signInAs(app, 'stranger@example.org');
    expect(location).toBe(`${BASE_URL}/not-invited?reason=not_invited`);
    expect(jar.get(SESSION_COOKIE)).toBeUndefined();
    expect(users(db)).toEqual([]);
    expect(db.orm.select().from(account).all()).toEqual([]);
  });

  it('rejects an unverified email even when it is allowlisted', async () => {
    const { app, db } = appWith({ ROOSTER_ALLOWED_DOMAINS: 'example.org' });
    const { location } = await signInAs(app, 'unverified@example.org', {
      idp,
      emailVerified: false,
    });
    expect(location).toBe(`${BASE_URL}/not-invited?reason=unverified_email`);
    expect(users(db)).toEqual([]);
  });

  it('admits allowlisted emails and domains from env and from the admin allowlist', async () => {
    const { app, db } = appWith({
      ROOSTER_ALLOWED_EMAILS: 'Env.Person@Example.org',
      ROOSTER_ALLOWED_DOMAINS: 'northwind.example',
    });
    expect((await signInAs(app, 'env.person@example.org')).location).toBe('/');
    expect((await signInAs(app, 'anna@Northwind.example')).location).toBe('/');
    expect((await signInAs(app, 'anna@sub.northwind.example')).location).toContain('not-invited');

    const { jar: admin } = await signInAs(app, 'admin@example.com');
    const add = await app.request(
      '/api/v1/admin/allowlist',
      asJar(admin, {
        method: 'POST',
        body: JSON.stringify({ kind: 'domain', value: 'Acme.test' }),
      }),
    );
    expect(add.status).toBe(201);
    expect((await signInAs(app, 'wile@acme.test')).location).toBe('/');
    expect(
      users(db)
        .map((u) => u.email)
        .sort(),
    ).toEqual([
      'admin@example.com',
      'anna@northwind.example',
      'env.person@example.org',
      'wile@acme.test',
    ]);
  });

  it('AC-1.2 the first sign-in creates one personal org with Inbox, Today, Prio, Upcoming', async () => {
    const { app, db } = appWith();
    const { jar } = await signInAs(app, 'admin@example.com');
    await signInAs(app, 'admin@example.com', { jar });
    const [me] = users(db);
    const orgs = db.orm.select().from(organization).all();
    expect(orgs).toHaveLength(1);
    expect(orgs[0]).toMatchObject({ isPersonal: true, name: 'Personal' });
    expect(orgs[0]?.slug).toMatch(/^personal-[0-9a-f]{8}$/);
    expect(groupNames(db, me?.id ?? '', orgs[0]?.id ?? '')).toEqual([
      'Inbox',
      'Today',
      'Prio',
      'Upcoming',
    ]);
  });

  it('AC-1.2 uses Swedish names when the browser language is sv-SE', async () => {
    const { app, db } = appWith();
    const { jar } = await signInAs(app, 'admin@example.com', {
      acceptLanguage: 'sv-SE,sv;q=0.9,en-US;q=0.8',
    });
    const [me] = users(db);
    expect(me?.locale).toBe('sv');
    const [org] = db.orm.select().from(organization).all();
    expect(org?.name).toBe('Personligt');
    expect(groupNames(db, me?.id ?? '', org?.id ?? '')).toEqual([
      'Inkorg',
      'Idag',
      'Prio',
      'Kommande',
    ]);
    const body = (await (await app.request('/api/v1/me', asJar(jar))).json()) as {
      locale: string;
    };
    expect(body.locale).toBe('sv');
  });

  it('links a second identity with the same verified email when its provider is trusted for email (FR-AUTH-5)', async () => {
    const second = await startMockIdp();
    try {
      const providers = [
        idp.provider('dev'),
        { ...second.provider('corp', 'Corp SSO'), trustEmail: true },
      ];
      const { app, db } = createTestApp({
        env: { ROOSTER_OIDC_PROVIDERS: JSON.stringify(providers) },
      });
      await signInAs(app, 'admin@example.com');
      const { jar, location } = await signInAs(app, 'admin@example.com', { provider: 'corp' });
      expect(location).toBe('/');
      expect(jar.get(SESSION_COOKIE)).toBeDefined();
      expect(users(db)).toHaveLength(1);
      expect(providerIds(db)).toEqual(['corp', 'dev']);
    } finally {
      await second.stop();
    }
  });

  it('an untrusted provider asserting an existing verified email cannot sign in as that user', async () => {
    const second = await startMockIdp();
    try {
      const providers = [idp.provider('dev'), second.provider('rogue', 'Rogue SSO')];
      const { app, db } = createTestApp({
        env: { ROOSTER_OIDC_PROVIDERS: JSON.stringify(providers) },
      });
      const { jar: owner } = await signInAs(app, 'admin@example.com');
      const { jar, location } = await signInAs(app, 'admin@example.com', { provider: 'rogue' });
      expect(location).toBe(`${BASE_URL}/not-invited?reason=account_link_blocked`);
      expect(jar.get(SESSION_COOKIE)).toBeUndefined();
      expect(users(db)).toHaveLength(1);
      expect(providerIds(db)).toEqual(['dev']);
      expect(db.orm.select().from(session).all()).toHaveLength(1);
      // The owner's own provider still works, and so does their session.
      expect((await signInAs(app, 'admin@example.com')).location).toBe('/');
      expect((await app.request('/api/v1/me', asJar(owner))).status).toBe(200);
    } finally {
      await second.stop();
    }
  });

  it('an untrusted provider still signs in new users and its own returning users', async () => {
    const second = await startMockIdp();
    try {
      const providers = [idp.provider('dev'), second.provider('rogue', 'Rogue SSO')];
      const { app, db } = createTestApp({
        env: {
          ROOSTER_OIDC_PROVIDERS: JSON.stringify(providers),
          ROOSTER_ALLOWED_DOMAINS: 'example.org',
        },
      });
      expect((await signInAs(app, 'new@example.org', { provider: 'rogue' })).location).toBe('/');
      expect((await signInAs(app, 'new@example.org', { provider: 'rogue' })).location).toBe('/');
      expect(users(db)).toHaveLength(1);
      expect(providerIds(db)).toEqual(['rogue']);
      // ...but the other untrusted provider cannot join that account either.
      expect((await signInAs(app, 'new@example.org')).location).toBe(
        `${BASE_URL}/not-invited?reason=account_link_blocked`,
      );
    } finally {
      await second.stop();
    }
  });

  it('a disabled user cannot sign in, and the existing session is rejected', async () => {
    const { app, db } = appWith({ ROOSTER_ALLOWED_DOMAINS: 'example.org' });
    const { jar: admin } = await signInAs(app, 'admin@example.com');
    const { jar: bob } = await signInAs(app, 'bob@example.org');
    const bobId = users(db).find((u) => u.email === 'bob@example.org')?.id ?? '';
    const disable = await app.request(
      `/api/v1/admin/users/${bobId}`,
      asJar(admin, { method: 'PATCH', body: JSON.stringify({ disabled: true }) }),
    );
    expect(disable.status).toBe(200);
    expect(db.orm.select().from(session).where(eq(session.userId, bobId)).all()).toEqual([]);
    expect((await app.request('/api/v1/me', asJar(bob))).status).toBe(401);
    const again = await signInAs(app, 'bob@example.org');
    expect(again.location).toBe(`${BASE_URL}/not-invited?reason=account_disabled`);
    expect(again.jar.get(SESSION_COOKIE)).toBeUndefined();
  });

  it('AC-1.7 a revoked session is rejected on its next request', async () => {
    const { app } = appWith();
    const { jar: laptop } = await signInAs(app, 'admin@example.com');
    const { jar: phone } = await signInAs(app, 'admin@example.com');
    const list = (await (await app.request('/api/v1/me/sessions', asJar(laptop))).json()) as {
      id: string;
      current: boolean;
    }[];
    expect(list).toHaveLength(2);
    const other = list.find((s) => !s.current);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    const revoke = await app.request(
      `/api/v1/me/sessions/${other?.id}`,
      asJar(laptop, { method: 'DELETE' }),
    );
    expect(revoke.status).toBe(204);
    expect((await app.request('/api/v1/me', asJar(phone))).status).toBe(401);
    expect((await app.request('/api/v1/me', asJar(laptop))).status).toBe(200);
  });

  it('signing out through better-auth ends the session', async () => {
    const { app } = appWith();
    const { jar } = await signInAs(app, 'admin@example.com');
    const out = await app.request('/api/auth/sign-out', asJar(jar, { method: 'POST', body: '{}' }));
    expect(out.status).toBe(200);
    expect((await app.request('/api/v1/me', asJar(jar))).status).toBe(401);
  });
});

describe('AC-1.3 link invites carry sign-in', () => {
  it('B (not allowlisted) signs in through a claimed link and becomes a member; a single-use link works once', async () => {
    const { app, db } = appWith();
    const { jar: a } = await signInAs(app, 'admin@example.com');
    const created = await app.request(
      '/api/v1/orgs',
      asJar(a, { method: 'POST', body: JSON.stringify({ name: 'Northwind' }) }),
    );
    expect(created.status).toBe(201);
    const org = (await created.json()) as { id: string; slug: string };
    expect(org.slug).toBe('northwind');

    const inviteRes = await app.request(
      `/api/v1/orgs/${org.id}/invites`,
      asJar(a, { method: 'POST', body: JSON.stringify({ role: 'member' }) }),
    );
    expect(inviteRes.status).toBe(201);
    const invite = (await inviteRes.json()) as { kind: string; url: string };
    expect(invite.kind).toBe('link');
    const token = invite.url.slice(`${BASE_URL}/invite/`.length);

    // B opens the invite page, which claims the invite, then signs in.
    const b = new CookieJar();
    const claim = await app.request(`/api/v1/invites/${token}/claim`, {
      method: 'POST',
      headers: { origin: BASE_URL },
    });
    expect(claim.status).toBe(200);
    expect(await claim.json()).toMatchObject({ orgName: 'Northwind', valid: true });
    b.update(claim);
    expect(b.get(INVITE_COOKIE)).toBeDefined();
    const signedIn = await signInAs(app, 'bob@elsewhere.test', { jar: b });
    expect(signedIn.location).toBe('/');
    expect(b.get(INVITE_COOKIE)).toBeUndefined();

    const orgs = (await (await app.request('/api/v1/orgs', asJar(b))).json()) as {
      name: string;
      role: string;
      isPersonal: boolean;
    }[];
    expect(orgs.map((o) => [o.name, o.role, o.isPersonal])).toEqual([
      ['Personal', 'owner', true],
      ['Northwind', 'member', false],
    ]);
    const bob = users(db).find((u) => u.email === 'bob@elsewhere.test');
    expect(groupNames(db, bob?.id ?? '', org.id)).toEqual(['Inbox', 'Today', 'Prio', 'Upcoming']);

    // The single-use link is spent: claiming fails and C cannot get in with it.
    const second = await app.request(`/api/v1/invites/${token}/claim`, {
      method: 'POST',
      headers: { origin: BASE_URL },
    });
    expect(second.status).toBe(410);
    expect(await second.json()).toMatchObject({ code: 'invite_invalid' });
    const preview = (await (await app.request(`/api/v1/invites/${token}`)).json()) as {
      valid: boolean;
      reason: string;
    };
    expect(preview).toMatchObject({ valid: false, reason: 'used' });

    // B signs in again later without the invite: membership of a shared org admits them...
    expect((await signInAs(app, 'bob@elsewhere.test')).location).toBe('/');
    // ...until they are removed from it.
    const removed = await app.request(
      `/api/v1/orgs/${org.id}/members/${bob?.id}`,
      asJar(a, { method: 'DELETE' }),
    );
    expect(removed.status).toBe(204);
    expect((await signInAs(app, 'bob@elsewhere.test')).location).toBe(
      `${BASE_URL}/not-invited?reason=not_invited`,
    );
  });

  it('a stale claim cookie does not admit anyone once the link is spent', async () => {
    const { app, db } = appWith();
    const { jar: a } = await signInAs(app, 'admin@example.com');
    const org = (await (
      await app.request(
        '/api/v1/orgs',
        asJar(a, { method: 'POST', body: JSON.stringify({ name: 'Acme' }) }),
      )
    ).json()) as { id: string };
    const { url } = (await (
      await app.request(
        `/api/v1/orgs/${org.id}/invites`,
        asJar(a, { method: 'POST', body: JSON.stringify({}) }),
      )
    ).json()) as { url: string };
    const token = url.split('/invite/')[1] ?? '';
    const claim = await app.request(`/api/v1/invites/${token}/claim`, {
      method: 'POST',
      headers: { origin: BASE_URL },
    });
    const b = new CookieJar().update(claim);
    const c = new CookieJar().update(claim);
    expect((await signInAs(app, 'b@else.test', { jar: b })).location).toBe('/');
    expect((await signInAs(app, 'c@else.test', { jar: c })).location).toContain('/not-invited');
    expect(users(db).map((u) => u.email)).not.toContain('c@else.test');
  });

  it('an existing user signing in through a claimed invite joins the org', async () => {
    const { app } = appWith({ ROOSTER_ALLOWED_EMAILS: 'carol@example.org' });
    const { jar: a } = await signInAs(app, 'admin@example.com');
    const { jar: carol } = await signInAs(app, 'carol@example.org');
    const org = (await (
      await app.request(
        '/api/v1/orgs',
        asJar(a, { method: 'POST', body: JSON.stringify({ name: 'Team' }) }),
      )
    ).json()) as { id: string };
    const { url } = (await (
      await app.request(
        `/api/v1/orgs/${org.id}/invites`,
        asJar(a, { method: 'POST', body: JSON.stringify({ email: 'Carol@example.org' }) }),
      )
    ).json()) as { url: string };
    const token = url.split('/invite/')[1] ?? '';
    carol.update(
      await app.request(`/api/v1/invites/${token}/claim`, {
        method: 'POST',
        headers: { origin: BASE_URL },
      }),
    );
    await signInAs(app, 'carol@example.org', { jar: carol });
    const orgs = (await (await app.request('/api/v1/orgs', asJar(carol))).json()) as {
      name: string;
    }[];
    expect(orgs.map((o) => o.name)).toEqual(['Personal', 'Team']);
  });

  it('a pending email invite admits its address (rule 3)', async () => {
    const { app } = appWith();
    const { jar: a } = await signInAs(app, 'admin@example.com');
    const org = (await (
      await app.request(
        '/api/v1/orgs',
        asJar(a, { method: 'POST', body: JSON.stringify({ name: 'Mail team' }) }),
      )
    ).json()) as { id: string };
    await app.request(
      `/api/v1/orgs/${org.id}/invites`,
      asJar(a, { method: 'POST', body: JSON.stringify({ email: 'dave@mail.test' }) }),
    );
    expect((await signInAs(app, 'dave@mail.test')).location).toBe('/');
    expect((await signInAs(app, 'eve@mail.test')).location).toContain('/not-invited');
  });
});

describe('a single-use link and concurrent sign-ins', () => {
  async function linkInvite(app: App, owner: CookieJar): Promise<{ orgId: string; token: string }> {
    const org = (await (
      await app.request(
        '/api/v1/orgs',
        asJar(owner, { method: 'POST', body: JSON.stringify({ name: 'Race' }) }),
      )
    ).json()) as { id: string };
    const { url } = (await (
      await app.request(
        `/api/v1/orgs/${org.id}/invites`,
        asJar(owner, { method: 'POST', body: JSON.stringify({ role: 'member' }) }),
      )
    ).json()) as { url: string };
    return { orgId: org.id, token: url.split('/invite/')[1] ?? '' };
  }

  it('admits only the sign-in that consumes the invite; the other gets no session', async () => {
    const { app, db } = appWith();
    const { jar: a } = await signInAs(app, 'admin@example.com');
    const { orgId, token } = await linkInvite(app, a);
    const claim = await app.request(`/api/v1/invites/${token}/claim`, {
      method: 'POST',
      headers: { origin: BASE_URL },
    });
    const b = new CookieJar().update(claim);
    const c = new CookieJar().update(claim);
    expect((await signInAs(app, 'b@else.test', { jar: b })).location).toBe('/');
    // C's admission check ran before B's sign-in consumed the link, as when both callbacks
    // interleave: the check passes, accepting at session creation does not.
    const admits = vi.spyOn(app.services.orgs, 'inviteAdmits').mockReturnValue(true);
    const late = await signInAs(app, 'c@else.test', { jar: c });
    admits.mockRestore();
    expect(late.location).toBe(`${BASE_URL}/not-invited?reason=not_invited`);
    expect(c.get(SESSION_COOKIE)).toBeUndefined();
    const carl = users(db).find((u) => u.email === 'c@else.test');
    expect(
      db.orm
        .select()
        .from(session)
        .where(eq(session.userId, carl?.id ?? ''))
        .all(),
    ).toEqual([]);
    const members = (await (
      await app.request(`/api/v1/orgs/${orgId}/members`, asJar(a))
    ).json()) as {
      email: string;
    }[];
    expect(members.map((m) => m.email).sort()).toEqual(['admin@example.com', 'b@else.test']);
  });

  it('a stale invite cookie does not stop someone who is admitted anyway', async () => {
    const { app } = appWith({ ROOSTER_ALLOWED_DOMAINS: 'else.test' });
    const { jar: a } = await signInAs(app, 'admin@example.com');
    const { token } = await linkInvite(app, a);
    const claim = await app.request(`/api/v1/invites/${token}/claim`, {
      method: 'POST',
      headers: { origin: BASE_URL },
    });
    const b = new CookieJar().update(claim);
    const c = new CookieJar().update(claim);
    expect((await signInAs(app, 'b@else.test', { jar: b })).location).toBe('/');
    const late = await signInAs(app, 'c@else.test', { jar: c });
    expect(late.location).toBe('/');
    expect(c.get(SESSION_COOKIE)).toBeDefined();
  });
});

describe('cookies on https', () => {
  const HTTPS = 'https://rooster.example.com';

  it('the session and invite cookies are __Host- prefixed: Secure, Path=/, no Domain', async () => {
    const { app } = appWith({ ROOSTER_BASE_URL: HTTPS });
    const { jar: a } = await signInAs(app, 'admin@example.com', { origin: HTTPS });
    const session = a.get(`__Host-${SESSION_COOKIE}`);
    expect(session).toBeDefined();
    expect(a.get(SESSION_COOKIE)).toBeUndefined();
    const me = await app.request('/api/v1/me', { headers: { cookie: a.header() } });
    expect(me.status).toBe(200);
    // The plain name is not accepted on https.
    const plain = await app.request('/api/v1/me', {
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    });
    expect(plain.status).toBe(401);

    const org = (await (
      await app.request('/api/v1/orgs', {
        method: 'POST',
        body: JSON.stringify({ name: 'Secure' }),
        headers: { cookie: a.header(), origin: HTTPS, 'content-type': 'application/json' },
      })
    ).json()) as { id: string };
    const { url } = (await (
      await app.request(`/api/v1/orgs/${org.id}/invites`, {
        method: 'POST',
        body: JSON.stringify({ role: 'member' }),
        headers: { cookie: a.header(), origin: HTTPS, 'content-type': 'application/json' },
      })
    ).json()) as { url: string };
    const claim = await app.request(`/api/v1/invites/${url.split('/invite/')[1]}/claim`, {
      method: 'POST',
      headers: { origin: HTTPS },
    });
    const [invite] = claim.headers.getSetCookie();
    expect(invite).toMatch(new RegExp(`^__Host-${INVITE_COOKIE}=`));
    for (const attr of ['Secure', 'Path=/', 'HttpOnly']) expect(invite).toContain(attr);
    expect(invite).not.toMatch(/Domain=/i);

    // The prefixed invite cookie carries a stranger through sign-in.
    const b = new CookieJar().update(claim);
    const signedIn = await signInAs(app, 'bob@elsewhere.test', { jar: b, origin: HTTPS });
    expect(signedIn.location).toBe('/');
    expect(b.get(`__Host-${INVITE_COOKIE}`)).toBeUndefined();
    const setCookies = await signInAs(app, 'admin@example.com', { origin: HTTPS });
    expect(setCookies.jar.get(`__Host-${SESSION_COOKIE}`)).toBeDefined();
  });

  it('better-auth sets the session cookie with the __Host- attributes', async () => {
    const { app } = appWith({ ROOSTER_BASE_URL: HTTPS });
    const start = await app.request('/api/auth/sign-in/social', {
      ...jsonBody('POST', { provider: 'dev', callbackURL: '/', loginHint: 'admin@example.com' }),
      headers: { 'content-type': 'application/json', origin: HTTPS },
    });
    const jar = new CookieJar().update(start);
    const { url } = (await start.json()) as { url: string };
    const callback = new URL(
      (await fetch(url, { redirect: 'manual' })).headers.get('location') ?? '',
    );
    const done = await app.request(`${callback.pathname}${callback.search}`, {
      headers: { cookie: jar.header() },
    });
    const cookie = done.headers
      .getSetCookie()
      .find((c) => c.startsWith(`__Host-${SESSION_COOKIE}=`));
    expect(cookie).toBeDefined();
    for (const attr of ['Secure', 'Path=/', 'HttpOnly', 'SameSite=Lax']) {
      expect(cookie).toContain(attr);
    }
    expect(cookie).not.toMatch(/Domain=/i);
  });
});
