import type { Me, Org } from '@rooster/core/schemas';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { orgMemberPref, user } from '../src/db/schema/index.ts';
import { asJar, type CookieJar, createTestApp, createUserWithSession } from './helpers.ts';

function setup() {
  const { app, db } = createTestApp({ env: { ROOSTER_ADMIN_EMAILS: 'admin@example.com' } });
  const call = async (jar: CookieJar, method: string, path: string, body?: unknown) =>
    app.request(
      path,
      asJar(jar, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    );
  return { app, db, call };
}

async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T;
}

describe('GET/PATCH /me', () => {
  it('returns the profile, defaults, orgs and isAdmin', async () => {
    const { app, db, call } = setup();
    const { jar, userId } = createUserWithSession(app, db, {
      email: 'ann@example.com',
      name: 'Ann',
    });
    const me = await json<Me>(call(jar, 'GET', '/api/v1/me'));
    expect(me).toMatchObject({
      id: userId,
      name: 'Ann',
      email: 'ann@example.com',
      locale: 'en',
      timezone: 'UTC',
      weekStart: 1,
      dateFormat: 'MMM d',
      timeFormat: '24h',
      isAdmin: false,
      prefs: { parseTitleDates: true, completeHideMs: 1500 },
    });
    expect(me.orgs).toHaveLength(1);
    expect(me.orgs[0]).toMatchObject({ isPersonal: true, role: 'owner' });
    const admin = createUserWithSession(app, db, { email: 'Admin@Example.com' });
    expect((await json<Me>(call(admin.jar, 'GET', '/api/v1/me'))).isAdmin).toBe(true);
  });

  it('updates settings, canonicalises the timezone and merges prefs', async () => {
    const { app, db, call } = setup();
    const { jar, userId } = createUserWithSession(app, db, { email: 'ann@example.com' });
    const me = await json<Me>(
      call(jar, 'PATCH', '/api/v1/me', {
        name: ' Ann A. ',
        locale: 'sv',
        timezone: 'europe/stockholm',
        weekStart: 0,
        dateFormat: 'd MMM',
        timeFormat: '12h',
        prefs: { completeHideMs: 3000 },
      }),
    );
    expect(me).toMatchObject({
      name: 'Ann A.',
      locale: 'sv',
      timezone: 'Europe/Stockholm',
      weekStart: 0,
      dateFormat: 'd MMM',
      timeFormat: '12h',
    });
    const again = await json<Me>(
      call(jar, 'PATCH', '/api/v1/me', { prefs: { swipeLeft: 'none' } }),
    );
    expect(again.prefs).toMatchObject({ completeHideMs: 3000, swipeLeft: 'none' });
    const stored = db.orm.select({ prefs: user.prefs }).from(user).where(eq(user.id, userId)).get();
    expect(JSON.parse(stored?.prefs ?? '{}')).toEqual({ completeHideMs: 3000, swipeLeft: 'none' });
    const noop = await json<Me>(call(jar, 'PATCH', '/api/v1/me', {}));
    expect(noop.timezone).toBe('Europe/Stockholm');
  });

  it.each([
    { timezone: 'Mars/Olympus' },
    { timezone: '+01:00' },
    { locale: 'de' },
    { weekStart: 3 },
    { prefs: { completeHideMs: -1 } },
    { name: '' },
  ])('rejects %j with 422', async (patch) => {
    const { app, db, call } = setup();
    const { jar } = createUserWithSession(app, db, { email: 'ann@example.com' });
    const res = await call(jar, 'PATCH', '/api/v1/me', patch);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'validation_failed' });
  });
});

describe('sessions', () => {
  it('lists sessions with the current one marked; revoking someone else’s is 404', async () => {
    const { app, db, call } = setup();
    const ann = createUserWithSession(app, db, { email: 'ann@example.com' });
    const bo = createUserWithSession(app, db, { email: 'bo@example.com' });
    const list = await json<{ id: string; current: boolean; userAgent: string }[]>(
      call(ann.jar, 'GET', '/api/v1/me/sessions'),
    );
    expect(list).toEqual([expect.objectContaining({ id: ann.sessionId, current: true })]);
    expect((await call(ann.jar, 'DELETE', `/api/v1/me/sessions/${bo.sessionId}`)).status).toBe(404);
    expect((await call(bo.jar, 'GET', '/api/v1/me')).status).toBe(200);
    expect((await call(ann.jar, 'DELETE', `/api/v1/me/sessions/${ann.sessionId}`)).status).toBe(
      204,
    );
    expect((await call(ann.jar, 'GET', '/api/v1/me')).status).toBe(401);
  });
});

describe('sidebar org order (FR-ORG-6)', () => {
  async function threeOrgs() {
    const ctx = setup();
    const ann = createUserWithSession(ctx.app, ctx.db, { email: 'ann@example.com' });
    for (const name of ['One', 'Two']) await ctx.call(ann.jar, 'POST', '/api/v1/orgs', { name });
    const orgs = await json<Org[]>(ctx.call(ann.jar, 'GET', '/api/v1/orgs'));
    const [personal, one, two] = orgs as [Org, Org, Org];
    const names = async () =>
      (await json<Me>(ctx.call(ann.jar, 'GET', '/api/v1/me'))).orgs.map((o) => o.name);
    const move = (body: unknown) => ctx.call(ann.jar, 'PUT', '/api/v1/me/org-order', body);
    return { ...ctx, ann, personal, one, two, names, move };
  }

  it('AC-1.5 moving an org above Personal persists, and only for that user', async () => {
    const { app, db, call } = setup();
    const a = createUserWithSession(app, db, { email: 'a@example.com' });
    const b = createUserWithSession(app, db, { email: 'b@example.com' });
    const shared = await json<Org>(call(a.jar, 'POST', '/api/v1/orgs', { name: 'Northwind' }));
    const { url } = await json<{ url: string }>(
      call(a.jar, 'POST', `/api/v1/orgs/${shared.id}/invites`, {}),
    );
    await call(b.jar, 'POST', `/api/v1/invites/${url.split('/invite/')[1]}/accept`);
    const bOrgs = await json<Org[]>(call(b.jar, 'GET', '/api/v1/orgs'));
    expect(bOrgs.map((o) => o.name)).toEqual(['Personal', 'Northwind']);
    const personal = bOrgs[0] as Org;

    const res = await call(b.jar, 'PUT', '/api/v1/me/org-order', {
      orgId: shared.id,
      afterId: null,
      beforeId: personal.id,
    });
    expect(res.status).toBe(200);
    const { position } = await json<{ position: string }>(res);
    expect(position < personal.position).toBe(true);
    // "Reload": a fresh read returns the new order.
    const reloaded = await json<Me>(call(b.jar, 'GET', '/api/v1/me'));
    expect(reloaded.orgs.map((o) => o.name)).toEqual(['Northwind', 'Personal']);
    const aOrgs = await json<Org[]>(call(a.jar, 'GET', '/api/v1/orgs'));
    expect(aOrgs.map((o) => o.name)).toEqual(['Personal', 'Northwind']);
  });

  it('places between neighbours, at the end without neighbours, and by slug or alias', async () => {
    const { personal, one, two, names, move } = await threeOrgs();
    await move({ orgId: two.id, afterId: personal.id, beforeId: one.id });
    expect(await names()).toEqual(['Personal', 'Two', 'One']);
    await move({ orgId: 'personal' });
    expect(await names()).toEqual(['Two', 'One', 'Personal']);
    await move({ orgId: one.slug, afterId: 'personal' });
    expect(await names()).toEqual(['Two', 'Personal', 'One']);
    await move({ orgId: 'one', beforeId: two.id });
    expect(await names()).toEqual(['One', 'Two', 'Personal']);
  });

  it('falls back to the end for a stale or inconsistent intent', async () => {
    const { personal, one, two, names, move } = await threeOrgs();
    const res = await move({ orgId: personal.id, afterId: two.id, beforeId: one.id });
    expect(res.status).toBe(200);
    expect(await names()).toEqual(['One', 'Two', 'Personal']);
    await move({ orgId: one.id, afterId: '0192f3a0-0000-7000-8000-000000000000' });
    expect(await names()).toEqual(['Two', 'Personal', 'One']);
    expect((await move({ orgId: 'nope' })).status).toBe(404);
  });

  it('re-keys the sidebar when keys collide', async () => {
    const { db, ann, one, two, names, move } = await threeOrgs();
    db.orm
      .update(orgMemberPref)
      .set({ position: 'a0' })
      .where(eq(orgMemberPref.userId, ann.userId))
      .run();
    const res = await move({ orgId: two.id, afterId: 'personal', beforeId: one.id });
    expect(res.status).toBe(200);
    const after = await names();
    expect(after.indexOf('Two')).toBe(after.indexOf('Personal') + 1);
    const positions = db.orm
      .select({ position: orgMemberPref.position })
      .from(orgMemberPref)
      .where(eq(orgMemberPref.userId, ann.userId))
      .all()
      .map((p) => p.position);
    expect(new Set(positions).size).toBe(3);
  });
});

describe('admin', () => {
  it('manages the allowlist: normalises, rejects duplicates and bad values, removes', async () => {
    const { app, db, call } = setup();
    const admin = createUserWithSession(app, db, { email: 'admin@example.com' });
    const email = await call(admin.jar, 'POST', '/api/v1/admin/allowlist', {
      kind: 'email',
      value: 'Pat@Example.org',
    });
    expect(email.status).toBe(201);
    const entry = await json<{ id: string; value: string }>(email);
    expect(entry.value).toBe('pat@example.org');
    const dup = await call(admin.jar, 'POST', '/api/v1/admin/allowlist', {
      kind: 'email',
      value: 'PAT@example.org',
    });
    expect(dup.status).toBe(409);
    for (const bad of [
      { kind: 'domain', value: 'https://x.test' },
      { kind: 'domain', value: 'localhost' },
      { kind: 'email', value: 'nope' },
      { kind: 'other', value: 'x.test' },
    ]) {
      expect((await call(admin.jar, 'POST', '/api/v1/admin/allowlist', bad)).status).toBe(422);
    }
    const domain = await json<{ value: string }>(
      call(admin.jar, 'POST', '/api/v1/admin/allowlist', { kind: 'domain', value: ' Acme.TEST ' }),
    );
    expect(domain.value).toBe('acme.test');
    const list = await json<{ kind: string; value: string }[]>(
      call(admin.jar, 'GET', '/api/v1/admin/allowlist'),
    );
    expect(list.map((e) => `${e.kind}:${e.value}`)).toEqual([
      'domain:acme.test',
      'email:pat@example.org',
    ]);
    expect((await call(admin.jar, 'DELETE', `/api/v1/admin/allowlist/${entry.id}`)).status).toBe(
      204,
    );
    expect((await call(admin.jar, 'DELETE', `/api/v1/admin/allowlist/${entry.id}`)).status).toBe(
      404,
    );
  });

  it('lists users, disables (revoking sessions) and re-enables them; not oneself', async () => {
    const { app, db, call } = setup();
    const admin = createUserWithSession(app, db, { email: 'admin@example.com' });
    const bo = createUserWithSession(app, db, { email: 'bo@example.com' });
    const users = await json<{ email: string; isAdmin: boolean; disabledAt: number | null }[]>(
      call(admin.jar, 'GET', '/api/v1/admin/users'),
    );
    expect(users.map((u) => [u.email, u.isAdmin, u.disabledAt])).toEqual([
      ['bo@example.com', false, null],
      ['admin@example.com', true, null],
    ]);
    const disabled = await json<{ disabledAt: number | null }>(
      call(admin.jar, 'PATCH', `/api/v1/admin/users/${bo.userId}`, { disabled: true }),
    );
    expect(disabled.disabledAt).toEqual(expect.any(Number));
    expect((await call(bo.jar, 'GET', '/api/v1/me')).status).toBe(401);
    const enabled = await json<{ disabledAt: number | null }>(
      call(admin.jar, 'PATCH', `/api/v1/admin/users/${bo.userId}`, { disabled: false }),
    );
    expect(enabled.disabledAt).toBeNull();
    // The old session was deleted; re-enabling does not resurrect it.
    expect((await call(bo.jar, 'GET', '/api/v1/me')).status).toBe(401);
    const self = await call(admin.jar, 'PATCH', `/api/v1/admin/users/${admin.userId}`, {
      disabled: true,
    });
    expect(self.status).toBe(409);
    expect(await self.json()).toMatchObject({ code: 'cannot_disable_self' });
    expect(
      (
        await call(admin.jar, 'PATCH', '/api/v1/admin/users/0192f3a0-0000-7000-8000-000000000000', {
          disabled: true,
        })
      ).status,
    ).toBe(404);
  });
});
