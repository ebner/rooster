import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { isPublicRoute } from '../src/auth/actor.ts';
import { INVITE_COOKIE, inviteCookie, readInviteToken } from '../src/auth/cookies.ts';
import { member, organization } from '../src/db/schema/index.ts';
import { localeFromAcceptLanguage, parseAcceptLanguage, serverText } from '../src/lib/i18n.ts';
import {
  hashToken,
  randomToken,
  readCookie,
  signCookieValue,
  verifyCookieValue,
} from '../src/lib/tokens.ts';
import { emailInviteToken, parseInviteToken } from '../src/services/invite-tokens.ts';
import { emailDomain, matchesAllowlist } from '../src/services/sign-in-policy.ts';
import { BASE_URL, createTestApp, createUserWithSession, TEST_ENV } from './helpers.ts';

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
    expect(header).toMatch(/^rooster\.invite=/);
    expect(header).toContain('Max-Age=900');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Secure');
    const cookie = `${header.split(';')[0]}`;
    expect(readInviteToken(cookie, SECRET, now)).toBe('tok');
    expect(readInviteToken(cookie, SECRET, now + 15 * 60_000)).toBeNull();
    expect(readInviteToken(cookie, 'another-secret-another-secret-0000', now)).toBeNull();
    expect(
      readInviteToken(`${INVITE_COOKIE}=${signCookieValue(SECRET, 'tok')}`, SECRET, now),
    ).toBeNull();
    expect(readInviteToken('other=1', SECRET, now)).toBeNull();
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

  it('does not apply to safe methods, and bearer requests are exempt (then need a session)', async () => {
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
