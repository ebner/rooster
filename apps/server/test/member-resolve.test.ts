// 11 §2.1 (security audit, boundary 3): apps and tokens with a grant see member names, never
// colleagues' emails; they assign by email, name or "me" through the server's resolution.
import type { Member, Org, ResolvedMember, Task } from '@rooster/core/schemas';
import { describe, expect, it } from 'vitest';
import type { Actor } from '../src/services/index.ts';
import { ALL, bearer, pat } from './grant-helpers.ts';
import { listCtx, sharedOrg } from './list-helpers.ts';

async function setup() {
  const ctx = listCtx();
  const owner = ctx.user('owner@example.com', 'Olle Ägare');
  const bob = ctx.user('bob@example.com', 'Robert Ek');
  const cleo = ctx.user('cleo@example.com', 'Cleo Berg');
  const outsider = ctx.user('outsider@example.com', 'Otto Utanför');
  const org = await sharedOrg(owner, [bob, cleo]);
  const other = await owner.ok<Org>('POST', '/api/v1/orgs', { name: 'Elsewhere' }, 201);
  const token = (await pat(owner, ALL)).token;
  return { ctx, owner, bob, cleo, outsider, org, other, api: bearer(ctx, token) };
}

const resolvePath = (orgId: string, q: string) =>
  `/api/v1/orgs/${orgId}/members/resolve?q=${encodeURIComponent(q)}`;

describe('member emails stay with the browser (11 §2.1)', () => {
  it('lists emails for the browser session', async () => {
    const { owner, org } = await setup();
    const members = await owner.ok<Member[]>('GET', `/api/v1/orgs/${org.id}/members`);
    expect(members.map((m) => m.email).sort()).toEqual([
      'bob@example.com',
      'cleo@example.com',
      'owner@example.com',
    ]);
  });

  it('lists names and ids, never emails, for a grant', async () => {
    const { ctx, api, org, owner } = await setup();
    const res = await api.call('GET', `/api/v1/orgs/${org.id}/members`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('@');
    const members = JSON.parse(text) as Member[];
    expect(members.map((m) => m.name).sort()).toEqual(['Cleo Berg', 'Olle Ägare', 'Robert Ek']);
    for (const m of members) expect(m).not.toHaveProperty('email');
    // A CLI device session (a grant of kind `device`) is held to the same rule.
    const device: Actor = {
      ...owner.actor,
      via: 'bearer',
      grant: {
        id: 'grant',
        kind: 'device',
        clientId: 'rooster-cli',
        scopes: ['tasks:read'],
        constraints: { orgs: 'all' },
        updatedAt: 0,
      },
    };
    for (const m of ctx.app.services.orgs.listMembers(device, org.id)) {
      expect(m).not.toHaveProperty('email');
    }
  });
});

describe('the @member title token', () => {
  it('matches email local parts for the browser only', async () => {
    const { owner, api, org, bob } = await setup();
    const body = { title: 'Call @bob', parse: true };
    const browser = await owner.ok<Task>('POST', `/api/v1/orgs/${org.id}/tasks`, body, 201);
    expect(browser.assigneeId).toBe(bob.userId);
    const app = await api.ok<Task>('POST', `/api/v1/orgs/${org.id}/tasks`, body, 201);
    expect(app.assigneeId).not.toBe(bob.userId);
    expect(app.title).toBe('Call @bob');
    const byName = { title: 'Call @robert', parse: true };
    expect(
      (await api.ok<Task>('POST', `/api/v1/orgs/${org.id}/tasks`, byName, 201)).assigneeId,
    ).toBe(bob.userId);
  });
});

describe('GET /orgs/:orgId/members/resolve', () => {
  it('resolves an email in any case, without returning it', async () => {
    const { api, org, cleo } = await setup();
    const res = await api.call('GET', resolvePath(org.id, ' CLEO@example.COM '));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('@');
    expect(JSON.parse(text)).toEqual({ userId: cleo.userId, name: 'Cleo Berg' });
  });

  it('resolves a full name, ignoring case and accents', async () => {
    const { api, org, bob, owner } = await setup();
    expect(await api.ok<ResolvedMember>('GET', resolvePath(org.id, 'robert ek'))).toEqual({
      userId: bob.userId,
      name: 'Robert Ek',
    });
    expect((await api.ok<ResolvedMember>('GET', resolvePath(org.id, 'olle agare'))).userId).toBe(
      owner.userId,
    );
  });

  it('resolves me and mig to the caller', async () => {
    const { api, org, owner } = await setup();
    for (const q of ['me', 'MIG']) {
      expect((await api.ok<ResolvedMember>('GET', resolvePath(org.id, q))).userId).toBe(
        owner.userId,
      );
    }
  });

  it('answers an unknown email exactly like an unknown name', async () => {
    const { api, org } = await setup();
    const bodies = [];
    for (const q of [
      'nobody@example.com',
      'outsider@example.com', // a user, but not a member
      'Nobody At All',
      'Otto Utanför',
      'bob', // an email's local part never matches
      'Robert', // nor does part of a name
    ]) {
      const res = await api.call('GET', resolvePath(org.id, q));
      expect(res.status, q).toBe(404);
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0] ?? '{}')).toMatchObject({ code: 'not_found' });
  });

  it('names an ambiguous full name by name only', async () => {
    const { ctx, owner, api, org } = await setup();
    const twin = ctx.user('robert.ek@example.com', 'Robert Ek');
    const { url } = await owner.ok<{ url: string }>(
      'POST',
      `/api/v1/orgs/${org.id}/invites`,
      { role: 'member' },
      201,
    );
    await twin.ok('POST', `/api/v1/invites/${url.split('/invite/')[1]}/accept`);
    const res = await api.call('GET', resolvePath(org.id, 'Robert Ek'));
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).not.toContain('example.com');
    const problem = JSON.parse(text) as { code: string; members: ResolvedMember[] };
    expect(problem.code).toBe('ambiguous_member');
    expect(problem.members.map((m) => m.name)).toEqual(['Robert Ek', 'Robert Ek']);
    // The email still tells them apart.
    expect(
      (await api.ok<ResolvedMember>('GET', resolvePath(org.id, 'robert.ek@example.com'))).userId,
    ).toBe(twin.userId);
  });

  it('only considers orgs the grant reaches and the caller belongs to', async () => {
    const { ctx, owner, org, other, outsider } = await setup();
    const narrow = (
      await pat(owner, ALL, { orgs: [{ orgId: other.id, read: 'all', write: 'all' }] })
    ).token;
    const api = bearer(ctx, narrow);
    expect((await api.call('GET', resolvePath(org.id, 'bob@example.com'))).status).toBe(404);
    expect((await api.call('GET', resolvePath(other.id, 'me'))).status).toBe(200);
    // Someone who is not a member of the org gets the org's 404.
    const res = await outsider.call('GET', resolvePath(org.id, 'bob@example.com'));
    expect(res.status).toBe(404);
  });

  it('rejects an empty query', async () => {
    const { api, org } = await setup();
    expect((await api.call('GET', resolvePath(org.id, '  '))).status).toBe(422);
    expect((await api.call('GET', `/api/v1/orgs/${org.id}/members/resolve`)).status).toBe(422);
  });

  it('is rate-limited like any request', async () => {
    const ctx = listCtx({ apiRateLimit: { max: 0, windowMs: 60_000 } });
    const owner = ctx.user('owner@example.com');
    const res = await owner.call('GET', resolvePath('personal', 'me'));
    expect(res.status).toBe(429);
  });
});
