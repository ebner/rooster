import { eq, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { isPublicRoute } from '../src/auth/actor.ts';
import {
  INVITE_COOKIE,
  inviteCookie,
  inviteCookieName,
  readInviteToken,
  sessionCookieName,
} from '../src/auth/cookies.ts';
import { member, organization } from '../src/db/schema/index.ts';
import { clientIp } from '../src/lib/client-ip.ts';
import { localeFromAcceptLanguage, parseAcceptLanguage, serverText } from '../src/lib/i18n.ts';
import { createLogger } from '../src/lib/logger.ts';
import { loggablePath } from '../src/lib/request-log.ts';
import {
  hashToken,
  randomToken,
  readCookie,
  signCookieValue,
  verifyCookieValue,
} from '../src/lib/tokens.ts';
import { emailInviteToken, parseInviteToken } from '../src/services/invite-tokens.ts';
import { emailDomain, matchesAllowlist } from '../src/services/sign-in-policy.ts';
import {
  BASE_URL,
  captureLogger,
  createTestApp,
  createTestDb,
  createUserWithSession,
  TEST_ENV,
  testConfig,
} from './helpers.ts';

const SECRET = TEST_ENV.ROOSTER_AUTH_SECRET;

describe('allowlist matching', () => {
  const list = { emails: ['Ann@Example.com'], domains: ['Northwind.example'] };

  it.each([
    ['ann@example.com', true],
    ['ANN@EXAMPLE.COM', true],
    ['bob@example.com', false],
    ['bob@northwind.example', true],
    ['Bob@NORTHWIND.EXAMPLE', true],
    ['bob@sub.northwind.example', false],
    ['bob@northwind.example.evil.example', false],
    ['northwind.example@evil.example', false],
  ])('%s → %s', (email, ok) => {
    expect(matchesAllowlist(email, list)).toBe(ok);
  });

  it('takes the domain after the last @', () => {
    expect(emailDomain('"a@b"@Example.COM')).toBe('example.com');
  });
});

describe('Accept-Language', () => {
  it('orders by quality and drops q=0 and *', () => {
    expect(parseAcceptLanguage('en;q=0.5, sv-SE, sv;q=0.9, de;q=0, *;q=0.1')).toEqual([
      'sv-SE',
      'sv',
      'en',
    ]);
    expect(parseAcceptLanguage(undefined)).toEqual([]);
    expect(parseAcceptLanguage('xx;q=abc')).toEqual([]);
  });

  it('picks a supported locale, defaulting to English', () => {
    expect(localeFromAcceptLanguage('sv-SE,sv;q=0.9,en-US;q=0.8')).toBe('sv');
    expect(localeFromAcceptLanguage('de-DE,en-GB;q=0.5')).toBe('en');
    expect(localeFromAcceptLanguage('fr')).toBe('en');
    expect(localeFromAcceptLanguage(null)).toBe('en');
  });

  it('localises the default group names', () => {
    expect(serverText('sv', 'group.upcoming')).toBe('Kommande');
    expect(serverText('en', 'group.inbox')).toBe('Inbox');
  });
});

describe('signed values and tokens', () => {
  it('round-trips signed cookie values and rejects tampering', () => {
    const signed = signCookieValue(SECRET, 'abc.def');
    expect(verifyCookieValue(SECRET, signed)).toBe('abc.def');
    expect(verifyCookieValue('another-secret-another-secret-0000', signed)).toBeNull();
    expect(verifyCookieValue(SECRET, signed.replace('abc', 'abd'))).toBeNull();
    expect(verifyCookieValue(SECRET, 'nodot')).toBeNull();
    expect(verifyCookieValue(SECRET, '%E0%A4%A')).toBeNull();
  });

  it('reads a cookie from a Cookie header', () => {
    expect(readCookie('a=1; b=2;c=3', 'b')).toBe('2');
    expect(readCookie('a=1; junk; c=3', 'c')).toBe('3');
    expect(readCookie('a=1', 'b')).toBeNull();
    expect(readCookie(undefined, 'a')).toBeNull();
  });

  it('hashes tokens with SHA-256', () => {
    const token = randomToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).not.toBe(hashToken(randomToken()));
  });

  it('classifies invite tokens and rejects forged email tokens', () => {
    const id = '0192f3a0-0000-7000-8000-000000000001';
    const token = emailInviteToken(SECRET, id);
    expect(parseInviteToken(SECRET, token)).toEqual({ kind: 'email', id });
    expect(parseInviteToken('another-secret-another-secret-0000', token)).toBeNull();
    expect(parseInviteToken(SECRET, `not-a-uuid.${token.split('.')[1]}`)).toBeNull();
    const link = randomToken();
    expect(parseInviteToken(SECRET, link)).toEqual({ kind: 'link', tokenHash: hashToken(link) });
    expect(parseInviteToken(SECRET, 'short')).toBeNull();
  });

  it('the invite cookie expires after 15 minutes and resists tampering', () => {
    const now = 1_800_000_000_000;
    const header = inviteCookie(SECRET, 'tok', now, true);
    expect(header).toMatch(/^__Host-rooster\.invite=/);
    expect(header).toContain('Max-Age=900');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Secure');
    expect(header).toContain('Path=/');
    expect(header).not.toMatch(/Domain=/i);
    const cookie = `${header.split(';')[0]}`;
    expect(readInviteToken(cookie, SECRET, now, true)).toBe('tok');
    expect(readInviteToken(cookie, SECRET, now + 15 * 60_000, true)).toBeNull();
    expect(readInviteToken(cookie, 'another-secret-another-secret-0000', now, true)).toBeNull();
    expect(
      readInviteToken(`${INVITE_COOKIE}=${signCookieValue(SECRET, 'tok')}`, SECRET, now, false),
    ).toBeNull();
    expect(readInviteToken('other=1', SECRET, now, true)).toBeNull();
  });

  it('cookie names carry the __Host- prefix on https only', () => {
    expect(sessionCookieName(true)).toBe('__Host-rooster.session');
    expect(inviteCookieName(true)).toBe('__Host-rooster.invite');
    expect(sessionCookieName(false)).toBe('rooster.session');
    expect(inviteCookieName(false)).toBe('rooster.invite');
    const plain = inviteCookie(SECRET, 'tok', 0, false);
    expect(plain).toMatch(/^rooster\.invite=/);
    expect(plain).not.toContain('Secure');
    // A cookie under the other name is not read.
    expect(readInviteToken(plain.split(';')[0], SECRET, 0, true)).toBeNull();
    expect(readInviteToken(plain.split(';')[0], SECRET, 0, false)).toBe('tok');
  });
});

describe('public routes', () => {
  it.each([
    ['GET', '/api/v1/meta', true],
    ['GET', '/api/v1/openapi.json', true],
    ['GET', '/api/v1/invites/abc', true],
    ['POST', '/api/v1/invites/abc/claim', true],
    ['POST', '/api/v1/invites/abc/accept', false],
    ['POST', '/api/v1/meta', false],
    ['GET', '/api/v1/invites/abc/claim', false],
    ['GET', '/api/v1/me', false],
  ])('%s %s → %s', (method, path, expected) => {
    expect(isPublicRoute(method, path)).toBe(expected);
  });
});

describe('CSRF (04 §4.11)', () => {
  function setup() {
    const { app, db } = createTestApp();
    const { jar } = createUserWithSession(app, db, { email: 'ann@example.com' });
    const post = (headers: Record<string, string>, body = '{"name":"Org"}') =>
      app.request('/api/v1/orgs', {
        method: 'POST',
        body,
        headers: { cookie: jar.header(), 'content-type': 'application/json', ...headers },
      });
    return { app, post, jar };
  }

  it('rejects a cookie-authenticated mutation from another origin or without Origin', async () => {
    const { post } = setup();
    for (const headers of [{ origin: 'https://evil.example' }, {}, { origin: 'null' }]) {
      const res = await post(headers);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'csrf_origin' });
    }
  });

  it('accepts the same origin and rejects non-JSON bodies', async () => {
    const { post } = setup();
    expect((await post({ origin: BASE_URL })).status).toBe(201);
    const form = await post({ origin: BASE_URL, 'content-type': 'text/plain' }, 'name=Org');
    expect(form.status).toBe(415);
  });

  it('does not apply to safe methods; an unauthenticated bearer request is 401', async () => {
    const { app, jar, post } = setup();
    expect(
      (
        await app.request('/api/v1/orgs', {
          headers: { cookie: jar.header(), origin: 'https://x' },
        })
      ).status,
    ).toBe(200);
    const bearer = await app.request('/api/v1/orgs', {
      method: 'POST',
      body: '{"name":"Org"}',
      headers: { authorization: 'Bearer abc', 'content-type': 'application/json' },
    });
    expect(bearer.status).toBe(401);
    expect((await post({ origin: BASE_URL })).status).toBe(201);
  });

  it('an Authorization header does not exempt a cookie-authenticated request', async () => {
    const { post } = setup();
    // A bearer request is judged by its token alone (P8): the cookie riding along is ignored,
    // so a bogus token is 401 rather than a CSRF-exempt cookie request.
    for (const headers of [
      { authorization: 'Bearer abc' },
      { authorization: 'Bearer abc', origin: 'https://evil.example' },
    ]) {
      const res = await post(headers);
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ code: 'unauthenticated' });
    }
  });

  it('guards the public claim route too', async () => {
    const { app } = setup();
    const res = await app.request('/api/v1/invites/abc/claim', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
  });
});

describe('invariants', () => {
  it('every personal org has exactly one member, its owner (05 §2)', async () => {
    const { app, db } = createTestApp();
    for (const email of ['a@example.com', 'b@example.com', 'c@example.com']) {
      createUserWithSession(app, db, { email });
    }
    const counts = db.orm
      .select({ orgId: member.organizationId, n: sql<number>`count(*)`, role: member.role })
      .from(member)
      .innerJoin(organization, eq(organization.id, member.organizationId))
      .where(eq(organization.isPersonal, true))
      .groupBy(member.organizationId)
      .all();
    expect(counts).toHaveLength(3);
    expect(counts.every((c) => c.n === 1 && c.role === 'owner')).toBe(true);
  });

  it('bootstrapping a personal org is idempotent', () => {
    const { app, db } = createTestApp();
    const { userId } = createUserWithSession(app, db, { email: 'a@example.com' });
    const again = app.services.orgs.bootstrapPersonalOrg(userId, 'sv');
    expect(again.name).toBe('Personal');
    expect(db.orm.select().from(organization).all()).toHaveLength(1);
  });
});

describe('client IP behind trusted proxies (04 §4.11)', () => {
  function ctxWith(forwarded: string | undefined): Context {
    return {
      req: { header: (name: string) => (name === 'x-forwarded-for' ? forwarded : undefined) },
      env: { incoming: { socket: { remoteAddress: '10.0.0.9' } } },
    } as unknown as Context;
  }

  it('takes the entry the outermost trusted proxy appended, not the client-supplied first', () => {
    const one = { trustProxy: true, trustedProxyHops: 1 };
    expect(clientIp(ctxWith('1.1.1.1'), one)).toBe('1.1.1.1');
    expect(clientIp(ctxWith('6.6.6.6, 1.1.1.1'), one)).toBe('1.1.1.1');
    expect(clientIp(ctxWith(' 6.6.6.6 ,1.1.1.1 , '), one)).toBe('1.1.1.1');
    const two = { trustProxy: true, trustedProxyHops: 2 };
    expect(clientIp(ctxWith('6.6.6.6, 1.1.1.1, 172.16.0.2'), two)).toBe('1.1.1.1');
  });

  it('falls back to the socket peer with too few entries, no header, or no trust', () => {
    expect(clientIp(ctxWith('1.1.1.1'), { trustProxy: true, trustedProxyHops: 2 })).toBe(
      '10.0.0.9',
    );
    expect(clientIp(ctxWith(undefined), { trustProxy: true, trustedProxyHops: 1 })).toBe(
      '10.0.0.9',
    );
    expect(clientIp(ctxWith(''), { trustProxy: true, trustedProxyHops: 1 })).toBe('10.0.0.9');
    expect(clientIp(ctxWith('1.1.1.1'), { trustProxy: false, trustedProxyHops: 1 })).toBe(
      '10.0.0.9',
    );
  });
});

describe('better-auth rate limit keys on the proxy-added address', () => {
  it('a client cannot dodge the sign-in limit by prepending X-Forwarded-For entries', async () => {
    const app = createApp({
      config: testConfig({ ROOSTER_TRUST_PROXY: 'true', ROOSTER_WEB_DIR: '/nonexistent' }),
      db: createTestDb(),
      logger: createLogger('silent'),
      version: '0.0.0-test',
      authRateLimit: true,
    });
    const signIn = (forwarded: string) =>
      app.request('/api/auth/sign-in/social', {
        method: 'POST',
        body: JSON.stringify({ provider: 'google', callbackURL: '/' }),
        headers: {
          'content-type': 'application/json',
          origin: BASE_URL,
          'x-forwarded-for': forwarded,
        },
      });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await signIn(`10.0.0.${i}, 9.9.9.9`)).status);
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses.slice(3)).toEqual([429, 429, 429]);
    // Another client behind the same proxy is counted separately.
    expect((await signIn('9.9.9.9, 8.8.8.8')).status).toBe(200);
  });
});

describe('request log redaction', () => {
  it.each([
    ['/api/v1/invites/abc123', '/api/v1/invites/:token'],
    ['/api/v1/invites/abc123/claim', '/api/v1/invites/:token/claim'],
    ['/api/v1/invites/abc123/accept', '/api/v1/invites/:token/accept'],
    ['/invite/abc123', '/invite/:token'],
    ['/api/v1/orgs/x/invites', '/api/v1/orgs/x/invites'],
    ['/api/v1/me', '/api/v1/me'],
  ])('%s is logged as %s', (path, logged) => {
    expect(loggablePath(path)).toBe(logged);
  });

  it('request lines never contain an invite token', async () => {
    const { logger, lines } = captureLogger();
    const { app } = createTestApp({ logger });
    const token = 'secret-invite-token-0123456789';
    await app.request(`/api/v1/invites/${token}`);
    await app.request(`/api/v1/invites/${token}/claim`, {
      method: 'POST',
      headers: { origin: BASE_URL },
    });
    const requests = lines.filter((l) => l.msg === 'request');
    expect(requests.map((l) => l.path)).toEqual([
      '/api/v1/invites/:token',
      '/api/v1/invites/:token/claim',
    ]);
    expect(JSON.stringify(lines)).not.toContain(token);
  });
});
