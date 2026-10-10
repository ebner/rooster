// FR-SET-3: an unlinked sign-in identity stays blocked until the user allows it again. Without
// the block, an email authority would link it again by email on its next sign-in (FR-AUTH-5).

import { uuidv7 } from '@rooster/core/ids';
import type { LinkedIdentity, RemovedIdentity } from '@rooster/core/schemas';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app.ts';
import { SESSION_COOKIE } from '../src/auth/cookies.ts';
import type { AppDb } from '../src/db/client.ts';
import { account, session, unlinkedIdentity, user } from '../src/db/schema/index.ts';
import { asJar, BASE_URL, type CookieJar, createTestApp, jsonBody, signInAs } from './helpers.ts';
import { type MockIdp, startMockIdp, subjectFor } from './mock-idp.ts';

let idp: MockIdp;
let corpIdp: MockIdp;

beforeAll(async () => {
  idp = await startMockIdp();
  corpIdp = await startMockIdp();
});
afterAll(async () => {
  await idp.stop();
  await corpIdp.stop();
});

const REFUSED = `${BASE_URL}/login?error=identity_unlinked`;

/** Two email authorities: `dev` and `corp` (Corp SSO), and anyone at example.org may join. */
function twoProviders(): { app: App; db: AppDb } {
  const providers = [
    { ...idp.provider('dev'), trustEmail: true },
    { ...corpIdp.provider('corp', 'Corp SSO'), trustEmail: true },
  ];
  return createTestApp({
    env: {
      ROOSTER_OIDC_PROVIDERS: JSON.stringify(providers),
      ROOSTER_ALLOWED_DOMAINS: 'example.org',
    },
  });
}

async function call(app: App, jar: CookieJar, method: string, path: string): Promise<Response> {
  return app.request(path, method === 'GET' ? asJar(jar) : asJar(jar, jsonBody(method, {})));
}

async function json<T>(app: App, jar: CookieJar, path: string): Promise<T> {
  const res = await call(app, jar, 'GET', path);
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

function providersOf(db: AppDb, userId: string): string[] {
  return db.orm
    .select({ providerId: account.providerId })
    .from(account)
    .where(eq(account.userId, userId))
    .all()
    .map((a) => a.providerId)
    .sort();
}

/** Ada with both identities linked, signed in through `dev`. */
async function adaWithTwo(app: App, db: AppDb) {
  const { jar } = await signInAs(app, 'ada@example.org');
  expect((await signInAs(app, 'ada@example.org', { provider: 'corp' })).location).toBe('/');
  const ada = db.orm.select().from(user).where(eq(user.email, 'ada@example.org')).get();
  if (ada === undefined) throw new Error('ada was not created');
  expect(providersOf(db, ada.id)).toEqual(['corp', 'dev']);
  const linked = await json<LinkedIdentity[]>(app, jar, '/api/v1/me/identities');
  const corp = linked.find((i) => i.providerId === 'corp');
  if (corp === undefined) throw new Error('corp is not linked');
  return { jar, userId: ada.id, corpId: corp.id };
}

describe('FR-SET-3 an unlinked identity stays blocked until allowed again', () => {
  it('signing in through the removed identity is refused: no session, no re-link', async () => {
    const { app, db } = twoProviders();
    const { jar, userId, corpId } = await adaWithTwo(app, db);
    expect((await call(app, jar, 'DELETE', `/api/v1/me/identities/${corpId}`)).status).toBe(204);
    expect(providersOf(db, userId)).toEqual(['dev']);

    const removed = await json<RemovedIdentity[]>(app, jar, '/api/v1/me/identities/removed');
    expect(removed).toEqual([
      {
        id: corpId,
        providerId: 'corp',
        providerName: 'Corp SSO',
        email: 'ada@example.org',
        removedAt: expect.any(Number),
      },
    ]);
    // The provider's subject is never part of the DTO.
    expect(JSON.stringify(removed)).not.toContain(subjectFor('ada@example.org'));

    const sessionsBefore = db.orm.select().from(session).all().length;
    const attempt = await signInAs(app, 'ada@example.org', { provider: 'corp' });
    expect(attempt.location).toBe(REFUSED);
    expect(attempt.jar.get(SESSION_COOKIE)).toBeUndefined();
    expect(db.orm.select().from(session).all()).toHaveLength(sessionsBefore);
    expect(providersOf(db, userId)).toEqual(['dev']);
    expect(db.orm.select().from(user).all()).toHaveLength(1);
    // Refused again on a second try; the other identity and the open session still work.
    expect((await signInAs(app, 'ada@example.org', { provider: 'corp' })).location).toBe(REFUSED);
    expect((await signInAs(app, 'ada@example.org')).location).toBe('/');
    expect((await call(app, jar, 'GET', '/api/v1/me')).status).toBe(200);
  });

  it('allowing it again lets the next sign-in through it link as before', async () => {
    const { app, db } = twoProviders();
    const { jar, userId, corpId } = await adaWithTwo(app, db);
    await call(app, jar, 'DELETE', `/api/v1/me/identities/${corpId}`);
    expect((await signInAs(app, 'ada@example.org', { provider: 'corp' })).location).toBe(REFUSED);

    const allowed = await call(app, jar, 'DELETE', `/api/v1/me/identities/removed/${corpId}`);
    expect(allowed.status).toBe(204);
    expect(await json<RemovedIdentity[]>(app, jar, '/api/v1/me/identities/removed')).toEqual([]);
    const again = await signInAs(app, 'ada@example.org', { provider: 'corp' });
    expect(again.location).toBe('/');
    expect(again.jar.get(SESSION_COOKIE)).toBeDefined();
    expect(providersOf(db, userId)).toEqual(['corp', 'dev']);
    // Allowing twice is a 404: nothing is blocked any more.
    expect((await call(app, jar, 'DELETE', `/api/v1/me/identities/removed/${corpId}`)).status).toBe(
      404,
    );
  });

  it('unlinking it again after allowing records it again', async () => {
    const { app, db } = twoProviders();
    const { jar, corpId } = await adaWithTwo(app, db);
    await call(app, jar, 'DELETE', `/api/v1/me/identities/${corpId}`);
    await call(app, jar, 'DELETE', `/api/v1/me/identities/removed/${corpId}`);
    await signInAs(app, 'ada@example.org', { provider: 'corp' });
    const relinked = (await json<LinkedIdentity[]>(app, jar, '/api/v1/me/identities')).find(
      (i) => i.providerId === 'corp',
    );
    if (relinked === undefined) throw new Error('corp is not linked again');
    await call(app, jar, 'DELETE', `/api/v1/me/identities/${relinked.id}`);
    expect(
      (await json<RemovedIdentity[]>(app, jar, '/api/v1/me/identities/removed')).map((r) => r.id),
    ).toEqual([relinked.id]);
    expect((await signInAs(app, 'ada@example.org', { provider: 'corp' })).location).toBe(REFUSED);
  });

  it('the last identity can’t be unlinked, and nothing is recorded', async () => {
    const { app, db } = twoProviders();
    const { jar } = await signInAs(app, 'ada@example.org');
    const [only] = await json<LinkedIdentity[]>(app, jar, '/api/v1/me/identities');
    const res = await call(app, jar, 'DELETE', `/api/v1/me/identities/${only?.id}`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('last_identity');
    expect(db.orm.select().from(unlinkedIdentity).all()).toEqual([]);
    expect((await signInAs(app, 'ada@example.org')).location).toBe('/');
  });

  it('other users are unaffected, and cannot see or allow someone else’s removed identity', async () => {
    const { app, db } = twoProviders();
    const { jar: ada, corpId } = await adaWithTwo(app, db);
    await call(app, ada, 'DELETE', `/api/v1/me/identities/${corpId}`);

    const { jar: bob, location } = await signInAs(app, 'bob@example.org', { provider: 'corp' });
    expect(location).toBe('/');
    expect((await signInAs(app, 'bob@example.org')).location).toBe('/');
    expect(await json<RemovedIdentity[]>(app, bob, '/api/v1/me/identities/removed')).toEqual([]);
    expect((await call(app, bob, 'DELETE', `/api/v1/me/identities/removed/${corpId}`)).status).toBe(
      404,
    );
    expect(
      (await call(app, ada, 'DELETE', `/api/v1/me/identities/removed/${uuidv7()}`)).status,
    ).toBe(404);
    // Ada's block holds.
    expect((await signInAs(app, 'ada@example.org', { provider: 'corp' })).location).toBe(REFUSED);
  });

  it('a removed identity whose email now matches no account creates no user either', async () => {
    const { app, db } = twoProviders();
    const { userId } = await adaWithTwo(app, db);
    // The provider subject of a removed identity that now asserts another address.
    db.orm
      .insert(unlinkedIdentity)
      .values({
        id: uuidv7(),
        userId,
        providerId: 'corp',
        accountId: subjectFor('renamed@example.org'),
        email: 'ada.old@example.org',
        unlinkedAt: Date.now(),
      })
      .run();
    const attempt = await signInAs(app, 'renamed@example.org', { provider: 'corp' });
    expect(attempt.location).toBe(REFUSED);
    expect(attempt.jar.get(SESSION_COOKIE)).toBeUndefined();
    expect(db.orm.select().from(user).where(eq(user.email, 'renamed@example.org')).get()).toBe(
      undefined,
    );
  });

  it('better-auth cannot create an account row for a removed identity by any path', async () => {
    const { app, db } = twoProviders();
    const { jar, userId, corpId } = await adaWithTwo(app, db);
    const corp = db.orm.select().from(account).where(eq(account.id, corpId)).get();
    if (corp === undefined) throw new Error('corp account missing');
    await call(app, jar, 'DELETE', `/api/v1/me/identities/${corpId}`);
    const ctx = await app.auth.$context;
    await expect(
      ctx.internalAdapter.linkAccount({
        userId,
        providerId: 'corp',
        accountId: corp.accountId,
      }),
    ).rejects.toMatchObject({ body: { code: 'identity_unlinked' } });
    await expect(
      ctx.internalAdapter.createAccount({
        userId,
        providerId: 'corp',
        accountId: corp.accountId,
      }),
    ).rejects.toMatchObject({ body: { code: 'identity_unlinked' } });
    expect(providersOf(db, userId)).toEqual(['dev']);
  });
});
