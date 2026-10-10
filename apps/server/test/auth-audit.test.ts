// Security audit of Phase 11 (AC-11.1), boundary 1: sign-in, sessions and account linking.
// Each `it` names the finding it covers.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../src/auth/cookies.ts';
import { account, user } from '../src/db/schema/index.ts';
import { asJar, BASE_URL, CookieJar, createTestApp, idpEnv, signInAs } from './helpers.ts';
import { type MockIdp, startMockIdp } from './mock-idp.ts';

let idp: MockIdp;
let second: MockIdp;

beforeAll(async () => {
  idp = await startMockIdp();
  second = await startMockIdp();
});
afterAll(async () => {
  await idp.stop();
  await second.stop();
});

const HTTPS = 'https://rooster.example.com';

describe('boundary 1: sign-in and account linking', () => {
  it('P1 a generic OIDC provider named "google" is not an email authority', async () => {
    // No built-in Google: the `google` id is free for a generic provider without trustEmail.
    const providers = [idp.provider('dev'), second.provider('google', 'Not Google')];
    const { app, db, config } = createTestApp({
      env: {
        ROOSTER_OIDC_PROVIDERS: JSON.stringify(providers),
        // Unset the built-in Google of TEST_ENV.
        ROOSTER_GOOGLE_CLIENT_ID: undefined as unknown as string,
        ROOSTER_GOOGLE_CLIENT_SECRET: undefined as unknown as string,
      },
    });
    expect(config.google).toBeNull();
    await signInAs(app, 'admin@example.com');
    const { jar, location } = await signInAs(app, 'admin@example.com', { provider: 'google' });
    expect(location).toBe(`${BASE_URL}/not-invited?reason=account_link_blocked`);
    expect(jar.get(SESSION_COOKIE)).toBeUndefined();
    expect(
      db.orm
        .select()
        .from(account)
        .all()
        .map((a) => a.providerId),
    ).toEqual(['dev']);
  });

  it('P2 better-auth’s account endpoints (link, unlink, token export) are not reachable', async () => {
    const { app } = createTestApp({ env: idpEnv(idp) });
    const { jar } = await signInAs(app, 'admin@example.com');
    const idToken = await idp.idToken({ email: 'admin@example.com' });
    const calls: [string, string, unknown?][] = [
      ['GET', '/api/auth/list-accounts'],
      ['POST', '/api/auth/link-social', { provider: 'dev', idToken: { token: idToken } }],
      ['POST', '/api/auth/unlink-account', { providerId: 'dev' }],
      ['POST', '/api/auth/get-access-token', { providerId: 'dev' }],
      ['POST', '/api/auth/refresh-token', { providerId: 'dev' }],
      ['GET', '/api/auth/account-info'],
    ];
    for (const [method, path, body] of calls) {
      const res = await app.request(
        path,
        asJar(jar, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
      );
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toContain(idToken.slice(0, 40));
    }
    // The browser session still works.
    expect((await app.request('/api/v1/me', asJar(jar))).status).toBe(200);
  });

  it('P2 an ID token posted to /sign-in/social does not create a session', async () => {
    const { app } = createTestApp({ env: idpEnv(idp) });
    await signInAs(app, 'admin@example.com');
    const idToken = await idp.idToken({ email: 'admin@example.com' });
    const res = await app.request('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE_URL },
      body: JSON.stringify({ provider: 'dev', idToken: { token: idToken } }),
    });
    expect(res.status).toBe(400);
    const jar = new CookieJar().update(res);
    expect(jar.get(SESSION_COOKIE)).toBeUndefined();
    expect(await res.text()).not.toContain('"token"');
  });

  it('P2 on https every better-auth cookie is __Host- prefixed; a planted state cookie is ignored', async () => {
    const { app } = createTestApp({ env: { ...idpEnv(idp), ROOSTER_BASE_URL: HTTPS } });
    const start = (email: string) =>
      app.request('/api/auth/sign-in/social', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: HTTPS },
        body: JSON.stringify({ provider: 'dev', callbackURL: '/', loginHint: email }),
      });
    const mine = await start('admin@example.com');
    const cookies = mine.headers.getSetCookie();
    expect(cookies.length).toBeGreaterThan(0);
    for (const cookie of cookies) {
      expect(cookie).toMatch(/^__Host-rooster\./);
      expect(cookie).toContain('Secure');
      expect(cookie).not.toMatch(/Domain=/i);
    }
    // The attacker starts their own sign-in, then plants its state cookie (a sibling subdomain
    // can set `rooster.state` with Domain=, never `__Host-rooster.state`) and sends the victim
    // to their pending callback.
    const attacker = await start('admin@example.com');
    const attackerJar = new CookieJar().update(attacker);
    const stateValue = attackerJar.get('__Host-rooster.state');
    expect(stateValue).toBeDefined();
    const { url } = (await attacker.json()) as { url: string };
    const callback = new URL(
      (await fetch(url, { redirect: 'manual' })).headers.get('location') ?? '',
    );
    const victim = await app.request(`${callback.pathname}${callback.search}`, {
      headers: { cookie: `rooster.state=${stateValue}` },
    });
    const victimJar = new CookieJar().update(victim);
    expect(victimJar.get(`__Host-${SESSION_COOKIE}`)).toBeUndefined();
    expect(victimJar.get(SESSION_COOKIE)).toBeUndefined();
  });

  it('P3 an unverified email gets the same answer whether or not the account exists', async () => {
    const providers = [idp.provider('dev'), second.provider('corp', 'Corp SSO')];
    const { app, db } = createTestApp({
      env: {
        ROOSTER_OIDC_PROVIDERS: JSON.stringify(providers),
        ROOSTER_ALLOWED_DOMAINS: 'example.org',
      },
    });
    await signInAs(app, 'known@example.org');
    const known = await signInAs(app, 'known@example.org', {
      provider: 'corp',
      idp: second,
      emailVerified: false,
    });
    const unknown = await signInAs(app, 'unknown@example.org', {
      provider: 'corp',
      idp: second,
      emailVerified: false,
    });
    expect(unknown.location).toBe(`${BASE_URL}/not-invited?reason=unverified_email`);
    expect(known.location).toBe(unknown.location);
    expect(db.orm.select().from(user).all()).toHaveLength(1);
  });
});
