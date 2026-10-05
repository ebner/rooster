import type { Org } from '@rooster/core/schemas';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { App } from '../src/app.ts';
import type { AppDb } from '../src/db/client.ts';
import { member, organization, orgMemberPref, taskGroup } from '../src/db/schema/index.ts';
import { createLogger } from '../src/lib/logger.ts';
import { type Actor, createServices } from '../src/services/index.ts';
import {
  asJar,
  type CookieJar,
  createTestApp,
  createTestDb,
  createUserWithSession,
  insertUser,
  testConfig,
} from './helpers.ts';

interface Ctx {
  app: App;
  db: AppDb;
  call: (jar: CookieJar, method: string, path: string, body?: unknown) => Promise<Response>;
}

function setup(): Ctx {
  const { app, db } = createTestApp();
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

async function createOrg(ctx: Ctx, jar: CookieJar, name: string, extra = {}): Promise<Org> {
  const res = await ctx.call(jar, 'POST', '/api/v1/orgs', { name, ...extra });
  expect(res.status).toBe(201);
  return json<Org>(res);
}

/** Owner `a`, member `b` in org "Shared"; `c` is outside. */
async function sharedOrg(ctx: Ctx) {
  const a = createUserWithSession(ctx.app, ctx.db, { email: 'a@example.com', name: 'Ann' });
  const b = createUserWithSession(ctx.app, ctx.db, { email: 'b@example.com', name: 'Bo' });
  const c = createUserWithSession(ctx.app, ctx.db, { email: 'c@example.com', name: 'Cy' });
  const org = await createOrg(ctx, a.jar, 'Shared');
  const invite = await json<{ url: string }>(
    ctx.call(a.jar, 'POST', `/api/v1/orgs/${org.id}/invites`, { role: 'member' }),
  );
  const token = invite.url.split('/invite/')[1] ?? '';
  expect((await ctx.call(b.jar, 'POST', `/api/v1/invites/${token}/accept`)).status).toBe(200);
  return { a, b, c, org };
}

describe('orgs', () => {
  it('creates an org with a unique slug derived from the name; the creator is owner', async () => {
    const ctx = setup();
    const { jar } = createUserWithSession(ctx.app, ctx.db, { email: 'a@example.com' });
    const first = await createOrg(ctx, jar, 'Café Åkerö', { avatarEmoji: '☕', color: 'teal' });
    expect(first).toMatchObject({
      slug: 'cafe-akero',
      role: 'owner',
      isPersonal: false,
      avatarEmoji: '☕',
      color: 'teal',
      collapsed: false,
    });
    const second = await createOrg(ctx, jar, 'Café Åkerö');
    expect(second.slug).toBe('cafe-akero-2');
    const emoji = await createOrg(ctx, jar, '🚀');
    expect(emoji.slug).toBe('org');
    const taken = await ctx.call(jar, 'POST', '/api/v1/orgs', { name: 'X', slug: 'cafe-akero' });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ code: 'slug_taken' });
    const reserved = await ctx.call(jar, 'POST', '/api/v1/orgs', { name: 'X', slug: 'personal' });
    expect(reserved.status).toBe(422);
  });

  it('creates the Inbox and default groups for the creator', async () => {
    const ctx = setup();
    const { userId, jar } = createUserWithSession(ctx.app, ctx.db, { email: 'a@example.com' });
    const org = await createOrg(ctx, jar, 'Team');
    const groups = ctx.db.orm
      .select()
      .from(taskGroup)
      .where(and(eq(taskGroup.orgId, org.id), eq(taskGroup.userId, userId)))
      .all();
    expect(groups.filter((g) => g.kind === 'inbox')).toHaveLength(1);
    expect(groups.filter((g) => g.kind === 'normal').map((g) => g.name)).toHaveLength(3);
  });

  it('lists orgs in sidebar order, personal first, and resolves the `personal` alias', async () => {
    const ctx = setup();
    const { jar } = createUserWithSession(ctx.app, ctx.db, { email: 'a@example.com' });
    await createOrg(ctx, jar, 'One');
    await createOrg(ctx, jar, 'Two');
    const orgs = await json<Org[]>(ctx.call(jar, 'GET', '/api/v1/orgs'));
    expect(orgs.map((o) => o.name)).toEqual(['Personal', 'One', 'Two']);
    const personal = await json<Org>(
      ctx.call(jar, 'PATCH', '/api/v1/me/orgs/personal', { collapsed: true }),
    );
    expect(personal).toMatchObject({ isPersonal: true, collapsed: true });
    const bySlug = await json<Org>(
      ctx.call(jar, 'PATCH', '/api/v1/me/orgs/one', { collapsed: true }),
    );
    expect(bySlug.name).toBe('One');
  });

  it('renames an org (owner) and rejects renaming the personal org', async () => {
    const ctx = setup();
    const { jar } = createUserWithSession(ctx.app, ctx.db, { email: 'a@example.com' });
    const org = await createOrg(ctx, jar, 'Old');
    const renamed = await json<Org>(
      ctx.call(jar, 'PATCH', `/api/v1/orgs/${org.id}`, { name: '  New\u0007 name ', slug: 'new' }),
    );
    expect(renamed).toMatchObject({ name: 'New name', slug: 'new' });
    const personal = await ctx.call(jar, 'PATCH', '/api/v1/orgs/personal', { name: 'Shared!' });
    expect(personal.status).toBe(409);
    expect(await personal.json()).toMatchObject({ code: 'personal_org' });
    const restyled = await json<Org>(
      ctx.call(jar, 'PATCH', '/api/v1/orgs/personal', { avatarEmoji: '🐓', color: 'red' }),
    );
    expect(restyled).toMatchObject({ avatarEmoji: '🐓', color: 'red', isPersonal: true });
  });

  it('AC-1.4 the personal org rejects invites and cannot be deleted', async () => {
    const ctx = setup();
    const { jar } = createUserWithSession(ctx.app, ctx.db, { email: 'a@example.com' });
    for (const body of [{ role: 'member' }, { email: 'x@example.com', role: 'member' }]) {
      const res = await ctx.call(jar, 'POST', '/api/v1/orgs/personal/invites', body);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'personal_org' });
    }
    const del = await ctx.call(jar, 'DELETE', '/api/v1/orgs/personal', { confirmName: 'Personal' });
    expect(del.status).toBe(409);
    expect(await del.json()).toMatchObject({ code: 'personal_org' });
    const leave = await ctx.call(
      jar,
      'DELETE',
      `/api/v1/orgs/personal/members/${(await json<{ id: string }>(ctx.call(jar, 'GET', '/api/v1/me'))).id}`,
    );
    expect(leave.status).toBe(409);
  });

  it('deletes an org only with the exact name; it disappears and frees its slug', async () => {
    const ctx = setup();
    const { a, b, org } = await sharedOrg(ctx);
    const wrong = await ctx.call(a.jar, 'DELETE', `/api/v1/orgs/${org.id}`, {
      confirmName: 'shared',
    });
    expect(wrong.status).toBe(422);
    expect(await wrong.json()).toMatchObject({ code: 'confirm_name_mismatch' });
    const ok = await ctx.call(a.jar, 'DELETE', `/api/v1/orgs/${org.id}`, { confirmName: 'Shared' });
    expect(ok.status).toBe(204);
    const bOrgs = await json<Org[]>(ctx.call(b.jar, 'GET', '/api/v1/orgs'));
    expect(bOrgs.map((o) => o.name)).toEqual(['Personal']);
    expect((await ctx.call(a.jar, 'GET', `/api/v1/orgs/${org.id}/members`)).status).toBe(404);
    const again = await createOrg(ctx, a.jar, 'Shared');
    expect(again.slug).toBe('shared');
  });
});

describe('members', () => {
  it('lists members with roles; non-members get 404', async () => {
    const ctx = setup();
    const { b, c, org } = await sharedOrg(ctx);
    const members = await json<{ email: string; role: string }[]>(
      ctx.call(b.jar, 'GET', `/api/v1/orgs/${org.slug}/members`),
    );
    expect(members.map((m) => [m.email, m.role])).toEqual([
      ['a@example.com', 'owner'],
      ['b@example.com', 'member'],
    ]);
    expect((await ctx.call(c.jar, 'GET', `/api/v1/orgs/${org.id}/members`)).status).toBe(404);
  });

  it('FR-ORG-5 the last owner can be neither demoted nor leave; a second owner unblocks it', async () => {
    const ctx = setup();
    const { a, b, org } = await sharedOrg(ctx);
    const demote = await ctx.call(a.jar, 'PATCH', `/api/v1/orgs/${org.id}/members/${a.userId}`, {
      role: 'member',
    });
    expect(demote.status).toBe(409);
    expect(await demote.json()).toMatchObject({ code: 'last_owner' });
    const leave = await ctx.call(a.jar, 'DELETE', `/api/v1/orgs/${org.id}/members/${a.userId}`);
    expect(leave.status).toBe(409);

    const promote = await ctx.call(a.jar, 'PATCH', `/api/v1/orgs/${org.id}/members/${b.userId}`, {
      role: 'owner',
    });
    expect(await promote.json()).toMatchObject({ userId: b.userId, role: 'owner' });
    expect(
      (await ctx.call(a.jar, 'DELETE', `/api/v1/orgs/${org.id}/members/${a.userId}`)).status,
    ).toBe(204);
  });

  it('members may leave but not remove others; owners may remove members', async () => {
    const ctx = setup();
    const { a, b, c, org } = await sharedOrg(ctx);
    expect(
      (await ctx.call(b.jar, 'DELETE', `/api/v1/orgs/${org.id}/members/${a.userId}`)).status,
    ).toBe(403);
    expect(
      (await ctx.call(a.jar, 'DELETE', `/api/v1/orgs/${org.id}/members/${c.userId}`)).status,
    ).toBe(404);
    expect(
      (await ctx.call(b.jar, 'DELETE', `/api/v1/orgs/${org.id}/members/${b.userId}`)).status,
    ).toBe(204);
    expect((await ctx.call(b.jar, 'GET', `/api/v1/orgs/${org.id}/members`)).status).toBe(404);
  });

  it('05 §4.2 removing a member deletes their groups and sidebar pref; re-joining starts fresh', async () => {
    const ctx = setup();
    const { a, b, org } = await sharedOrg(ctx);
    const groupsOf = () =>
      ctx.db.orm
        .select()
        .from(taskGroup)
        .where(and(eq(taskGroup.orgId, org.id), eq(taskGroup.userId, b.userId)))
        .all();
    const prefOf = () =>
      ctx.db.orm
        .select()
        .from(orgMemberPref)
        .where(and(eq(orgMemberPref.orgId, org.id), eq(orgMemberPref.userId, b.userId)))
        .all();
    const before = groupsOf().map((g) => g.id);
    expect(before).toHaveLength(4);
    expect(prefOf()).toHaveLength(1);
    expect(
      (await ctx.call(a.jar, 'DELETE', `/api/v1/orgs/${org.id}/members/${b.userId}`)).status,
    ).toBe(204);
    expect(groupsOf()).toEqual([]);
    expect(prefOf()).toEqual([]);
    // A's groups are untouched.
    const aGroups = ctx.db.orm
      .select()
      .from(taskGroup)
      .where(and(eq(taskGroup.orgId, org.id), eq(taskGroup.userId, a.userId)))
      .all();
    expect(aGroups).toHaveLength(4);

    const { url } = await json<{ url: string }>(
      ctx.call(a.jar, 'POST', `/api/v1/orgs/${org.id}/invites`, { role: 'member' }),
    );
    await ctx.call(b.jar, 'POST', `/api/v1/invites/${url.split('/invite/')[1]}/accept`);
    const after = groupsOf().map((g) => g.id);
    expect(after).toHaveLength(4);
    expect(after.some((id) => before.includes(id))).toBe(false);
  });

  it('runs registered member-removal steps inside the transaction', () => {
    const db = createTestDb();
    const calls: { orgId: string; userId: string }[] = [];
    const services = createServices(
      { db, config: testConfig(), logger: createLogger('silent'), clock: Date.now },
      { memberRemovalSteps: [(_tx, scope) => calls.push(scope)] },
    );
    const actor = (userId: string): Actor => ({
      userId,
      email: `${userId}@example.com`,
      isAdmin: false,
      via: 'session',
      sessionId: 's',
      scopes: ['read', 'write'],
    });
    const a = actor(insertUser(db, { email: 'a@example.com' }));
    const b = actor(insertUser(db, { email: 'b@example.com' }));
    const org = services.orgs.create(a, { name: 'Steps' });
    const { url } = services.orgs.createInvite(a, org.id, { role: 'member' });
    services.orgs.acceptInvite(b, url.split('/invite/')[1] ?? '');
    services.orgs.removeMember(a, org.id, b.userId);
    expect(calls).toEqual([{ orgId: org.id, userId: b.userId }]);
  });
});

describe('invites', () => {
  it('lists open invites (owner only) and revokes either kind', async () => {
    const ctx = setup();
    const { a, b, org } = await sharedOrg(ctx);
    const email = await json<{ id: string; url: string }>(
      ctx.call(a.jar, 'POST', `/api/v1/orgs/${org.id}/invites`, {
        email: 'New@Example.com',
        role: 'owner',
        expiresInDays: 3,
      }),
    );
    const link = await json<{ id: string }>(
      ctx.call(a.jar, 'POST', `/api/v1/orgs/${org.id}/invites`, { multiUse: true }),
    );
    const open = await json<
      { id: string; kind: string; email: string | null; url: string | null }[]
    >(ctx.call(a.jar, 'GET', `/api/v1/orgs/${org.id}/invites`));
    expect(open.map((i) => i.kind).sort()).toEqual(['email', 'link']);
    expect(open.find((i) => i.kind === 'email')).toMatchObject({
      email: 'new@example.com',
      url: email.url,
    });
    expect(open.find((i) => i.kind === 'link')?.url).toBeNull();
    expect((await ctx.call(b.jar, 'GET', `/api/v1/orgs/${org.id}/invites`)).status).toBe(403);

    for (const id of [email.id, link.id]) {
      expect((await ctx.call(a.jar, 'DELETE', `/api/v1/orgs/${org.id}/invites/${id}`)).status).toBe(
        204,
      );
    }
    expect(await json(ctx.call(a.jar, 'GET', `/api/v1/orgs/${org.id}/invites`))).toEqual([]);
    expect(
      (await ctx.call(a.jar, 'DELETE', `/api/v1/orgs/${org.id}/invites/${link.id}`)).status,
    ).toBe(404);
    const preview = await json<{ valid: boolean; reason: string }>(
      ctx.app.request(`/api/v1/invites/${email.url.split('/invite/')[1]}`),
    );
    expect(preview).toMatchObject({ valid: false, reason: 'revoked' });
  });

  it('previews an invite without auth; forged and unknown tokens are 404', async () => {
    const ctx = setup();
    const { a, org } = await sharedOrg(ctx);
    const { url } = await json<{ url: string }>(
      ctx.call(a.jar, 'POST', `/api/v1/orgs/${org.id}/invites`, { email: 'z@example.com' }),
    );
    const token = url.split('/invite/')[1] ?? '';
    const preview = await json(ctx.app.request(`/api/v1/invites/${token}`));
    expect(preview).toMatchObject({
      kind: 'email',
      orgName: 'Shared',
      inviterName: 'Ann',
      email: 'z@example.com',
      role: 'member',
      valid: true,
      reason: null,
    });
    const forged = `${token.split('.')[0]}.${'A'.repeat(43)}`;
    expect((await ctx.app.request(`/api/v1/invites/${forged}`)).status).toBe(404);
    expect((await ctx.app.request(`/api/v1/invites/${'x'.repeat(43)}`)).status).toBe(404);
    expect((await ctx.app.request('/api/v1/invites/nope')).status).toBe(404);
  });

  it('an email invite is for its address only, and is used up by accepting', async () => {
    const ctx = setup();
    const { a, b, c, org } = await sharedOrg(ctx);
    const { url } = await json<{ url: string }>(
      ctx.call(a.jar, 'POST', `/api/v1/orgs/${org.id}/invites`, { email: 'c@example.com' }),
    );
    const token = url.split('/invite/')[1] ?? '';
    const wrong = await ctx.call(b.jar, 'POST', `/api/v1/invites/${token}/accept`);
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toMatchObject({ code: 'invite_email_mismatch' });
    const ok = await ctx.call(c.jar, 'POST', `/api/v1/invites/${token}/accept`);
    expect(await json(ok)).toMatchObject({ id: org.id, role: 'member' });
    expect((await ctx.call(c.jar, 'POST', `/api/v1/invites/${token}/accept`)).status).toBe(410);
  });

  it('rejects inviting an existing member and multi-use email invites', async () => {
    const ctx = setup();
    const { a, org } = await sharedOrg(ctx);
    const dup = await ctx.call(a.jar, 'POST', `/api/v1/orgs/${org.id}/invites`, {
      email: 'B@example.com',
    });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ code: 'already_member' });
    const multi = await ctx.call(a.jar, 'POST', `/api/v1/orgs/${org.id}/invites`, {
      email: 'n@example.com',
      multiUse: true,
    });
    expect(multi.status).toBe(422);
  });

  it('a multi-use link admits several people; accepting twice is a no-op; expiry ends it', async () => {
    let now = Date.now();
    const { app, db } = createTestApp({ clock: () => now });
    const call = async (jar: CookieJar, method: string, path: string, body?: unknown) =>
      app.request(
        path,
        asJar(jar, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
      );
    const a = createUserWithSession(app, db, { email: 'a@example.com' });
    const b = createUserWithSession(app, db, { email: 'b@example.com' });
    const c = createUserWithSession(app, db, { email: 'c@example.com' });
    const d = createUserWithSession(app, db, { email: 'd@example.com' });
    const org = await json<Org>(call(a.jar, 'POST', '/api/v1/orgs', { name: 'Multi' }));
    const { url, expiresAt } = await json<{ url: string; expiresAt: number }>(
      call(a.jar, 'POST', `/api/v1/orgs/${org.id}/invites`, { multiUse: true, expiresInDays: 1 }),
    );
    expect(expiresAt).toBe(now + 86_400_000);
    const token = url.split('/invite/')[1] ?? '';
    expect((await call(b.jar, 'POST', `/api/v1/invites/${token}/accept`)).status).toBe(200);
    expect((await call(b.jar, 'POST', `/api/v1/invites/${token}/accept`)).status).toBe(200);
    expect((await call(c.jar, 'POST', `/api/v1/invites/${token}/accept`)).status).toBe(200);
    const memberships = db.orm.select().from(member).where(eq(member.organizationId, org.id)).all();
    expect(memberships).toHaveLength(3);
    const open = await json<{ uses: number }[]>(
      call(a.jar, 'GET', `/api/v1/orgs/${org.id}/invites`),
    );
    expect(open[0]?.uses).toBe(2);
    now += 86_400_001;
    const late = await call(d.jar, 'POST', `/api/v1/invites/${token}/accept`);
    expect(late.status).toBe(410);
    expect(await json(app.request(`/api/v1/invites/${token}`))).toMatchObject({
      valid: false,
      reason: 'expired',
    });
  });

  it('an invite to a deleted org is invalid', async () => {
    const ctx = setup();
    const { a, c, org } = await sharedOrg(ctx);
    const { url } = await json<{ url: string }>(
      ctx.call(a.jar, 'POST', `/api/v1/orgs/${org.id}/invites`, {}),
    );
    await ctx.call(a.jar, 'DELETE', `/api/v1/orgs/${org.id}`, { confirmName: 'Shared' });
    const token = url.split('/invite/')[1] ?? '';
    expect(await json(ctx.app.request(`/api/v1/invites/${token}`))).toMatchObject({
      reason: 'org_deleted',
    });
    expect((await ctx.call(c.jar, 'POST', `/api/v1/invites/${token}/accept`)).status).toBe(410);
    expect(
      ctx.db.orm.select().from(organization).where(eq(organization.id, org.id)).get()?.deletedAt,
    ).not.toBeNull();
  });
});
