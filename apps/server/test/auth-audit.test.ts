// Security audit of Phase 11 (AC-11.1), boundary 1: sign-in, sessions and account linking.
// Each `it` names the finding it covers.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isSecureBaseUrl, SESSION_COOKIE } from '../src/auth/cookies.ts';
import { account, user } from '../src/db/schema/index.ts';
import { deviceLogin } from './grant-helpers.ts';
import { asJar, BASE_URL, CookieJar, createTestApp, idpEnv, signInAs } from './helpers.ts';
import { listCtx } from './list-helpers.ts';
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
  it('P1 a generic OIDC provider cannot take the id "google" (an email authority)', () => {
    // Refused at startup even with built-in Google off (config.ts), so `google` always means
    // the built-in provider; auth.ts also trusts it only when that provider is configured.
    const providers = [idp.provider('dev'), second.provider('google', 'Not Google')];
    expect(() =>
      createTestApp({
        env: {
          ROOSTER_OIDC_PROVIDERS: JSON.stringify(providers),
          ROOSTER_GOOGLE_CLIENT_ID: undefined as unknown as string,
          ROOSTER_GOOGLE_CLIENT_SECRET: undefined as unknown as string,
        },
      }),
    ).toThrow(/reserved for the built-in Google provider/);
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

describe('boundary 1, round 3: session lists', () => {
  it('P2 no session list hands out a CLI device’s bearer token', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const device = await deviceLogin(ctx, owner, {
      scopes: ['tasks:read'],
      constraints: { orgs: 'all' },
    });
    const better = await owner.call('GET', '/api/auth/list-sessions');
    expect(better.status).toBe(404);
    expect(await better.text()).not.toContain(device.token);
    // Nor do better-auth's get and update hand scripts the browser's own session token.
    for (const [method, path] of [
      ['GET', '/api/auth/get-session'],
      ['POST', '/api/auth/update-session'],
    ] as const) {
      const res = await owner.call(method, path, method === 'POST' ? {} : undefined);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toContain('"token"');
    }
    const ours = await owner.call('GET', '/api/v1/me/sessions');
    expect(ours.status).toBe(200);
    expect(await ours.text()).not.toContain(device.token);
    // The device itself still works.
    const me = await ctx.app.request('/api/v1/me', {
      headers: { authorization: `Bearer ${device.token}` },
    });
    expect(me.status).toBe(200);
  });
});

describe('boundary 1, round 5: https detection', () => {
  it('P2 an uppercase HTTPS scheme still gets __Host- cookies (one parsed check for auth and invite cookies)', async () => {
    expect(isSecureBaseUrl('HTTPS://rooster.example.com')).toBe(true);
    expect(isSecureBaseUrl('https://rooster.example.com')).toBe(true);
    expect(isSecureBaseUrl('http://localhost:3000')).toBe(false);
    const { app } = createTestApp({
      env: { ...idpEnv(idp), ROOSTER_BASE_URL: 'HTTPS://rooster.example.com' },
    });
    const start = await app.request('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: HTTPS },
      body: JSON.stringify({ provider: 'dev', callbackURL: '/', loginHint: 'admin@example.com' }),
    });
    const cookies = start.headers.getSetCookie();
    expect(cookies.length, `${start.status} ${await start.clone().text()}`).toBeGreaterThan(0);
    for (const cookie of cookies) {
      expect(cookie).toMatch(/^__Host-rooster\./);
      expect(cookie).toContain('Secure');
    }
  });
});

describe('boundary 1, round 6: sign-out', () => {
  it('P2 sign-out ends the session and hands out no provider logout URL or ID token', async () => {
    const discovery = (await (await fetch(idp.discoveryUrl)).json()) as Record<string, unknown>;
    expect(typeof discovery.end_session_endpoint).toBe('string');
    const { app, db } = createTestApp({ env: idpEnv(idp) });
    const { jar } = await signInAs(app, 'admin@example.com');
    const idToken = db.orm.select().from(account).all()[0]?.idToken ?? '';
    expect(idToken).not.toBe('');
    for (const body of [{ disableRedirect: true }, {}]) {
      const { jar: again } = await signInAs(app, 'admin@example.com');
      const res = await app.request(
        '/api/auth/sign-out',
        asJar(again, { method: 'POST', body: JSON.stringify(body) }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('location')).toBeNull();
      const text = await res.text();
      expect(text).not.toContain('id_token_hint');
      expect(text).not.toContain(idToken.slice(0, 40));
      expect((await app.request('/api/v1/me', asJar(again))).status).toBe(401);
    }
    expect((await app.request('/api/v1/me', asJar(jar))).status).toBe(200);
  });
});
