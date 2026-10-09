// WP 8.2: grants, PATs and CLI devices (11 §2, 04 §4.3–4.4, 06 §2.1). AC-8.2, AC-8.3, AC-8.5.
import { defaultKeyHasher } from '@better-auth/api-key';
import type { Activity, Grant, Me, MyList, Task, TokenCreated } from '@rooster/core/schemas';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { DEVICE_FLOW_PATHS } from '../src/auth/mount.ts';
import { accessGrant, apikey, session } from '../src/db/schema/index.ts';
import { deviceLabel, GRANT_TOUCH_MS } from '../src/services/grant-service.ts';
import {
  ALL,
  bearer,
  deviceCode,
  deviceLogin,
  pat,
  personalOrgId,
  pollToken,
} from './grant-helpers.ts';
import { BASE_URL, TEST_ENV } from './helpers.ts';
import { groupNamed, inboxOf, listCtx } from './list-helpers.ts';

describe('PATs (AC-8.3, 04 §4.4)', () => {
  it('AC-8.3 a read-only PAT can read but gets 403 forbidden_scope on a write', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    await owner.ok('POST', '/api/v1/orgs/personal/tasks', { title: 'Existing' }, 201);
    const { token, grant } = await pat(owner, ['tasks:read']);
    expect(token).toMatch(/^rooster_pat_[A-Za-z0-9]{48}$/);
    expect(grant).toMatchObject({
      kind: 'pat',
      scopes: ['tasks:read'],
      tokenPrefix: token.slice(0, 16),
    });
    const api = bearer(ctx, token);
    const page = await api.ok<{ items: Task[] }>('GET', '/api/v1/orgs/personal/tasks');
    expect(page.items.map((t) => t.title)).toEqual(['Existing']);
    await api.ok('GET', `/api/v1/tasks/${page.items[0]?.id}`);
    const denied = await api.problem('POST', '/api/v1/orgs/personal/tasks', { title: 'New' }, 403);
    expect(denied.code).toBe('forbidden_scope');
    expect(denied.detail).toContain('tasks:write');
  });

  it('stores only the hash, in the api-key plugin’s table, verifiable by the plugin', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const { token, grant } = await pat(owner, ['tasks:read']);
    const row = ctx.db.orm.select().from(apikey).get();
    expect(row?.key).toBe(await defaultKeyHasher(token));
    expect(JSON.parse(row?.metadata ?? '{}')).toEqual({ grantId: grant.id });
    const verified = await ctx.app.auth.api.verifyApiKey({ body: { key: token } });
    expect(verified.valid).toBe(true);
  });

  it('rejects unknown, expired and revoked PATs with 401, and session-only routes with 403', async () => {
    let now = Date.now();
    const ctx = listCtx({ clock: () => now });
    const owner = ctx.user('owner@example.com');
    const short = await pat(owner, ALL, { orgs: 'all' }, { expiresInDays: 1 });
    const api = bearer(ctx, short.token);
    await api.ok('GET', '/api/v1/me');
    expect((await bearer(ctx, `${short.token}x`).call('GET', '/api/v1/me')).status).toBe(401);
    for (const [method, path, body] of [
      [
        'POST',
        '/api/v1/me/tokens',
        { name: 'x', scopes: ['tasks:read'], constraints: { orgs: 'all' } },
      ],
      ['PATCH', '/api/v1/me', { name: 'x' }],
      ['GET', '/api/v1/me/sessions', undefined],
      ['GET', '/api/v1/orgs/personal/export?format=json', undefined],
      ['POST', '/api/v1/orgs', { name: 'New' }],
      ['GET', '/api/v1/me/push-subscriptions', undefined],
      ['GET', '/api/v1/me/notification-prefs', undefined],
    ] as const) {
      const problem = await api.problem(method, path, body, 403);
      expect(problem.code, path).toBe('forbidden_scope');
    }
    now += 2 * 86_400_000;
    expect((await api.call('GET', '/api/v1/me')).status).toBe(401);

    const other = await pat(owner, ['tasks:read']);
    const otherApi = bearer(ctx, other.token);
    await otherApi.ok('GET', '/api/v1/me');
    await owner.ok('DELETE', `/api/v1/me/grants/${other.grant.id}`, undefined, 204);
    expect((await otherApi.call('GET', '/api/v1/me')).status).toBe(401);
    expect(ctx.db.orm.select().from(apikey).all()).toHaveLength(1);
  });

  it('records last use at most once a minute, with the client IP', async () => {
    let now = Date.now();
    const ctx = listCtx({ clock: () => now });
    const owner = ctx.user('owner@example.com');
    const { token, grant } = await pat(owner, ['tasks:read']);
    const api = bearer(ctx, token);
    const lastUsed = () =>
      ctx.db.orm.select().from(accessGrant).where(eq(accessGrant.id, grant.id)).get()?.lastUsedAt;
    expect(lastUsed()).toBeNull();
    await api.ok('GET', '/api/v1/me');
    const first = lastUsed();
    expect(first).toBe(now);
    now += GRANT_TOUCH_MS - 1;
    await api.ok('GET', '/api/v1/me');
    expect(lastUsed()).toBe(first);
    now += 2;
    await api.ok('GET', '/api/v1/me');
    expect(lastUsed()).toBe(now);
    const listed = await api.ok<Grant[]>('GET', '/api/v1/me/grants');
    expect(listed.find((g) => g.id === grant.id)).toMatchObject({ current: true, lastUsedAt: now });
  });

  it('lets a PAT list grants and revoke only itself', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const a = await pat(owner, ['tasks:read']);
    const b = await pat(owner, ['tasks:read']);
    const api = bearer(ctx, a.token);
    expect((await api.ok<Grant[]>('GET', '/api/v1/me/grants')).map((g) => g.id).sort()).toEqual(
      [a.grant.id, b.grant.id].sort(),
    );
    expect((await api.call('DELETE', `/api/v1/me/grants/${b.grant.id}`)).status).toBe(403);
    expect(
      (await api.call('PATCH', `/api/v1/me/grants/${a.grant.id}`, { label: 'x' })).status,
    ).toBe(403);
    expect((await api.call('DELETE', `/api/v1/me/grants/${a.grant.id}`)).status).toBe(204);
    expect((await api.call('GET', '/api/v1/me')).status).toBe(401);
  });

  it('validates constraints against the user’s orgs and groups', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const other = ctx.user('other@example.com');
    const theirOrg = await personalOrgId(other);
    const theirGroup = (await groupNamed(other, 'Prio')).id;
    const orgId = await personalOrgId(owner);
    for (const constraints of [
      { orgs: [{ orgId: theirOrg, read: 'all', write: 'none' }] },
      { orgs: [{ orgId, read: 'all', write: { groups: [theirGroup] } }] },
    ]) {
      const res = await owner.call('POST', '/api/v1/me/tokens', {
        name: 'x',
        scopes: ['tasks:write'],
        constraints,
      });
      expect(res.status).toBe(422);
    }
  });
});

describe('AC-8.5 a PAT writing only in Prio', () => {
  async function setup() {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const orgA = await personalOrgId(owner);
    const prio = await groupNamed(owner, 'Prio');
    const today = await groupNamed(owner, 'Today');
    // Org B: a shared org of the same user, outside the grant.
    const orgB = await owner.ok<{ id: string }>('POST', '/api/v1/orgs', { name: 'Org B' }, 201);
    const inB = await owner.ok<Task>(
      'POST',
      `/api/v1/orgs/${orgB.id}/tasks`,
      { title: 'In B' },
      201,
    );
    const inToday = await owner.ok<Task>(
      'POST',
      '/api/v1/orgs/personal/tasks',
      { title: 'Book dentist', groupId: today.id },
      201,
    );
    const { token, grant } = await pat(owner, ['tasks:write', 'tasks:delete'], {
      orgs: [{ orgId: orgA, read: 'all', write: { groups: [prio.id] } }],
    });
    return { ctx, owner, orgA, orgB, prio, today, inB, inToday, grant, api: bearer(ctx, token) };
  }

  it('adds and completes tasks in Prio', async () => {
    const { api, prio } = await setup();
    const task = await api.ok<Task>(
      'POST',
      '/api/v1/orgs/personal/tasks',
      { title: 'Pay invoice', groupId: prio.id },
      201,
    );
    expect(task.placement?.groupId).toBe(prio.id);
    const done = await api.ok<{ task: Task }>('POST', `/api/v1/tasks/${task.id}/complete`, {
      completed: true,
    });
    expect(done.task.completedAt).not.toBeNull();
    // Subtasks of a task in Prio are inside the grant too.
    await api.ok('POST', '/api/v1/orgs/personal/tasks', { title: 'Sub', parentId: task.id }, 201);
  });

  it('rejects moving out of Prio and adding to Today with outside_grant naming Prio', async () => {
    const { api, prio, today, inToday } = await setup();
    const task = await api.ok<Task>(
      'POST',
      '/api/v1/orgs/personal/tasks',
      { title: 'Pay invoice', groupId: prio.id },
      201,
    );
    const moved = await api.problem(
      'POST',
      `/api/v1/tasks/${task.id}/move`,
      { groupId: today.id },
      403,
    );
    expect(moved).toMatchObject({ code: 'outside_grant' });
    expect(moved.detail).toContain('"Prio"');
    const added = await api.problem(
      'POST',
      '/api/v1/orgs/personal/tasks',
      { title: 'Nope', groupId: today.id },
      403,
    );
    expect(added.code).toBe('outside_grant');
    // The Inbox (no group given) is outside too, and so is editing a task in Today.
    expect(
      (await api.problem('POST', '/api/v1/orgs/personal/tasks', { title: 'x' }, 403)).code,
    ).toBe('outside_grant');
    const edit = await api.problem('PATCH', `/api/v1/tasks/${inToday.id}`, { title: 'x' }, 403);
    expect(edit.detail).toContain('"Book dentist" is in "Today"');
    const bulk = await api.ok<{ results: { id: string; ok: boolean; code?: string }[] }>(
      'POST',
      '/api/v1/tasks/bulk',
      { op: 'complete', ids: [inToday.id, task.id] },
    );
    expect(bulk.results).toEqual([
      { id: inToday.id, ok: false, code: 'outside_grant' },
      { id: task.id, ok: true },
    ]);
    // Org-wide writes need write access to the whole org.
    expect((await api.problem('POST', '/api/v1/orgs/personal/tags', { name: 'x' }, 403)).code).toBe(
      'outside_grant',
    );
  });

  it('cannot see org B (404) and lists only org A', async () => {
    const { api, orgB, inB } = await setup();
    expect((await api.call('GET', `/api/v1/tasks/${inB.id}`)).status).toBe(404);
    expect((await api.call('GET', `/api/v1/orgs/${orgB.id}/my-list`)).status).toBe(404);
    expect((await api.call('POST', `/api/v1/orgs/${orgB.id}/tasks`, { title: 'x' })).status).toBe(
      404,
    );
    const me = await api.ok<Me>('GET', '/api/v1/me');
    expect(me.orgs.map((o) => o.isPersonal)).toEqual([true]);
    const hits = await api.ok<{ task: Task }[]>('GET', '/api/v1/search?q=In');
    expect(hits.map((h) => h.task.id)).not.toContain(inB.id);
  });

  it('applies a narrowed grant on the very next request', async () => {
    const { api, owner, orgA, prio, grant } = await setup();
    const task = await api.ok<Task>(
      'POST',
      '/api/v1/orgs/personal/tasks',
      { title: 'Pay invoice', groupId: prio.id },
      201,
    );
    await owner.ok('PATCH', `/api/v1/me/grants/${grant.id}`, {
      constraints: { orgs: [{ orgId: orgA, read: 'all', write: 'none' }] },
    });
    const res = await api.problem(
      'POST',
      `/api/v1/tasks/${task.id}/complete`,
      { completed: true },
      403,
    );
    expect(res.code).toBe('outside_grant');
    await owner.ok('PATCH', `/api/v1/me/grants/${grant.id}`, { scopes: ['tasks:read'] });
    expect(
      (await api.problem('POST', `/api/v1/tasks/${task.id}/complete`, { completed: true }, 403))
        .code,
    ).toBe('forbidden_scope');
  });

  it('hides groups outside a read constraint from lists, get and search', async () => {
    const { ctx, owner, orgA, prio, inToday } = await setup();
    const inPrio = await owner.ok<Task>(
      'POST',
      '/api/v1/orgs/personal/tasks',
      { title: 'Visible', groupId: prio.id },
      201,
    );
    const { token } = await pat(owner, ['tasks:read'], {
      orgs: [{ orgId: orgA, read: { groups: [prio.id] }, write: 'none' }],
    });
    const api = bearer(ctx, token);
    const list = await api.ok<MyList>('GET', '/api/v1/orgs/personal/my-list');
    expect(list.groups.map((g) => g.name)).toEqual(['Prio']);
    expect(list.tasks.map((t) => t.id)).toEqual([inPrio.id]);
    expect((await api.call('GET', `/api/v1/tasks/${inToday.id}`)).status).toBe(404);
    const page = await api.ok<{ items: Task[] }>('GET', '/api/v1/orgs/personal/tasks?view=today');
    expect(page.items.map((t) => t.id)).not.toContain(inToday.id);
    expect(
      (await api.ok<{ task: Task }[]>('GET', '/api/v1/search?q=dentist')).map((h) => h.task.id),
    ).toEqual([]);
  });

  it('needs tasks:assign to give a task to someone else, and records via and grantId', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const bob = ctx.user('bob@example.com');
    const org = await owner.ok<{ id: string }>('POST', '/api/v1/orgs', { name: 'Team' }, 201);
    const { url } = await owner.ok<{ url: string }>(
      'POST',
      `/api/v1/orgs/${org.id}/invites`,
      { role: 'member' },
      201,
    );
    await bob.ok('POST', `/api/v1/invites/${url.split('/invite/')[1]}/accept`);
    const writer = bearer(ctx, (await pat(owner, ['tasks:write'])).token);
    const task = await writer.ok<Task>(
      'POST',
      `/api/v1/orgs/${org.id}/tasks`,
      { title: 'Mine' },
      201,
    );
    expect(
      (await writer.problem('PATCH', `/api/v1/tasks/${task.id}`, { assigneeId: bob.userId }, 403))
        .code,
    ).toBe('forbidden_scope');
    const assigner = await pat(owner, ['tasks:assign']);
    await bearer(ctx, assigner.token).ok('PATCH', `/api/v1/tasks/${task.id}`, {
      assigneeId: bob.userId,
    });
    const feed = await owner.ok<{ items: { kind: string; activity?: Activity }[] }>(
      'GET',
      `/api/v1/tasks/${task.id}/activity`,
    );
    const assigned = feed.items.find((i) => i.activity?.type === 'assigned')?.activity;
    expect(assigned?.via).toBe('pat');
    expect(assigned?.data).not.toHaveProperty('grantId');
    const raw = ctx.db.sqlite
      .prepare("SELECT data FROM activity WHERE type = 'assigned'")
      .get() as { data: string };
    expect(JSON.parse(raw.data)).toMatchObject({ grantId: assigner.grant.id });
  });
});

describe('AC-8.2 parse: true', () => {
  it('reads dates, #tags and >Group; an unknown >Group stays in the title (Inbox)', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const prio = await groupNamed(owner, 'Prio');
    const api = bearer(ctx, (await pat(owner, ALL)).token);
    const task = await api.ok<Task>(
      'POST',
      '/api/v1/orgs/personal/tasks',
      { title: 'Pay invoice tom #finance >Prio', parse: true },
      201,
    );
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect(task).toMatchObject({ title: 'Pay invoice', dueDate: tomorrow });
    expect(task.placement?.groupId).toBe(prio.id);
    const tags = await api.ok<{ id: string; name: string }[]>('GET', '/api/v1/orgs/personal/tags');
    expect(tags.map((t) => t.name)).toEqual(['finance']);
    expect(task.tagIds).toEqual([tags[0]?.id]);
    // An existing tag is reused, case-insensitively.
    const again = await api.ok<Task>(
      'POST',
      '/api/v1/orgs/personal/tasks',
      { title: 'File receipts #Finance', parse: true },
      201,
    );
    expect(again).toMatchObject({ title: 'File receipts', tagIds: [tags[0]?.id] });
    const unknown = await api.ok<Task>(
      'POST',
      '/api/v1/orgs/personal/tasks',
      { title: 'Call mum >Nowhere', parse: true },
      201,
    );
    expect(unknown.title).toBe('Call mum >Nowhere');
    expect(unknown.placement?.groupId).toBe((await inboxOf(owner)).id);
    // A title of tokens only keeps its text.
    const only = await api.ok<Task>(
      'POST',
      '/api/v1/orgs/personal/tasks',
      { title: '#idea', parse: true },
      201,
    );
    expect(only).toMatchObject({ title: '#idea', tagIds: [] });
  });
});

describe('CLI device flow (AC-8.1 server side, 07 §2)', () => {
  it('requests a code, approves it with constraints, and the token carries the grant', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const orgId = await personalOrgId(owner);
    const prio = await groupNamed(owner, 'Prio');
    const code = await deviceCode(ctx, 'tasks:read tasks:write');
    expect(code).toMatchObject({
      verification_uri: `${BASE_URL}/device`,
      expires_in: 600,
      interval: 5,
    });
    expect((await pollToken(ctx, code.device_code)).body.error).toBe('authorization_pending');
    const request = await owner.ok<{ requestedScopes: string[]; clientName: string }>(
      'GET',
      `/api/v1/device/${code.user_code.toLowerCase()}`,
    );
    expect(request).toMatchObject({ clientName: 'rooster CLI', requestedScopes: ['tasks:write'] });
    const constraints = { orgs: [{ orgId, read: 'all' as const, write: { groups: [prio.id] } }] };
    // No more than the CLI asked for.
    const wider = await owner.call('POST', `/api/v1/device/${code.user_code}/approve`, {
      scopes: ['tasks:delete'],
      constraints,
    });
    expect(wider.status).toBe(422);
    expect(((await wider.json()) as { code: string }).code).toBe('widening_not_allowed');
    const grant = await owner.ok<Grant>('POST', `/api/v1/device/${code.user_code}/approve`, {
      scopes: ['tasks:write'],
      constraints,
    });
    expect(grant).toMatchObject({
      kind: 'device',
      clientId: 'rooster-cli',
      label: 'rooster CLI on laptop',
      expiresAt: null,
    });
    // The interval applies between polls.
    expect((await pollToken(ctx, code.device_code)).body.error).toBe('slow_down');
    ctx.db.sqlite.prepare('UPDATE deviceCode SET last_polled_at = 0').run();
    const token = await pollToken(ctx, code.device_code);
    expect(token.status).toBe(200);
    expect(token.body).toMatchObject({ token_type: 'Bearer', scope: 'tasks:write' });
    const linked = ctx.db.orm.select().from(session).where(eq(session.grantId, grant.id)).all();
    expect(linked).toHaveLength(1);
    // The code is single-use.
    expect((await pollToken(ctx, code.device_code)).status).toBe(400);

    const api = bearer(ctx, token.body.access_token as string);
    expect((await api.ok<Me>('GET', '/api/v1/me')).id).toBe(owner.userId);
    expect((await api.ok<Grant[]>('GET', '/api/v1/me/grants')).find((g) => g.current)?.id).toBe(
      grant.id,
    );
    await api.ok(
      'POST',
      '/api/v1/orgs/personal/tasks',
      { title: 'From CLI', groupId: prio.id },
      201,
    );
    expect(
      (await api.problem('POST', '/api/v1/orgs/personal/tasks', { title: 'x' }, 403)).code,
    ).toBe('outside_grant');
    // Device sessions are listed under Connected apps, not as browser sessions.
    const sessions = await owner.ok<{ id: string }[]>('GET', '/api/v1/me/sessions');
    expect(sessions.map((s) => s.id)).not.toContain(linked[0]?.id);
    expect((await owner.call('DELETE', `/api/v1/me/sessions/${linked[0]?.id}`)).status).toBe(404);
    // `rooster logout`: the device revokes its own grant, which deletes the session.
    await api.ok('DELETE', `/api/v1/me/grants/${grant.id}`, undefined, 204);
    expect((await api.call('GET', '/api/v1/me')).status).toBe(401);
    expect(ctx.db.orm.select().from(session).where(eq(session.grantId, grant.id)).all()).toEqual(
      [],
    );
  });

  it('defaults to every scope, and a denied code answers access_denied', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const code = await deviceCode(ctx);
    const request = await owner.ok<{ requestedScopes: string[] }>(
      'GET',
      `/api/v1/device/${code.user_code}`,
    );
    expect(request.requestedScopes.sort()).toEqual(
      [
        'comments:write',
        'groups:write',
        'notifications:read',
        'tasks:assign',
        'tasks:delete',
      ].sort(),
    );
    await owner.ok('POST', `/api/v1/device/${code.user_code}/deny`, undefined, 204);
    expect((await owner.call('GET', `/api/v1/device/${code.user_code}`)).status).toBe(404);
    expect((await pollToken(ctx, code.device_code)).body.error).toBe('access_denied');
  });

  it('refuses unknown clients and scopes, and better-auth’s own approval endpoints', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const bad = async (body: Record<string, string>) =>
      (
        await ctx.app.request('/api/auth/device/code', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json() as Promise<{ error: string }>;
    expect((await bad({ client_id: 'other' })).error).toBe('invalid_client');
    expect((await bad({ client_id: 'rooster-cli', scope: 'root' })).error).toBe('invalid_scope');
    const code = await deviceCode(ctx);
    for (const path of ['/api/auth/device/approve', '/api/auth/device/deny']) {
      const res = await ctx.app.request(path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: owner.jar.header(),
          origin: BASE_URL,
        },
        body: JSON.stringify({ userCode: code.user_code }),
      });
      expect(res.status).toBe(404);
    }
    // A revoked grant is never turned into a session.
    const grant = await owner.ok<Grant>('POST', `/api/v1/device/${code.user_code}/approve`, {
      scopes: ['tasks:read'],
      constraints: { orgs: 'all' },
    });
    await owner.ok('DELETE', `/api/v1/me/grants/${grant.id}`, undefined, 204);
    const token = await pollToken(ctx, code.device_code);
    expect(token.body.error).toBe('access_denied');
    expect(
      ctx.db.orm.select().from(session).where(eq(session.userId, owner.userId)).all(),
    ).toHaveLength(1);
  });

  it('labels devices from the CLI user agent', () => {
    expect(deviceLabel('rooster-cli/1.0.0 (darwin; arm64; studio)')).toBe('rooster CLI on studio');
    expect(deviceLabel('rooster-cli/1.0.0 (win32; x64)')).toBe('rooster CLI on Windows');
    expect(deviceLabel('rooster-cli/1.0.0 (freebsd; x64)')).toBe('rooster CLI on freebsd');
    expect(deviceLabel('curl/8')).toBe('rooster CLI');
    expect(deviceLabel(null)).toBe('rooster CLI');
  });
});

describe('non-browser credentials stay out of /api/auth (default deny)', () => {
  it('rejects a device token and a PAT on every better-auth endpoint but the device flow', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const device = await deviceLogin(ctx, owner, {
      scopes: ['tasks:read'],
      constraints: { orgs: 'all' },
    });
    const { token: patToken } = await pat(owner, ['tasks:read']);
    const endpoints = Object.values(ctx.app.auth.api as Record<string, unknown>)
      .map(
        (e) =>
          e as {
            path?: unknown;
            options?: { method?: unknown; metadata?: { SERVER_ONLY?: boolean } };
          },
      )
      .filter((e) => typeof e.path === 'string' && e.options?.metadata?.SERVER_ONLY !== true)
      .map((e) => ({
        path: `/api/auth${e.path as string}`,
        methods: [e.options?.method].flat().filter((m): m is string => typeof m === 'string'),
      }));
    expect(endpoints.length).toBeGreaterThan(30);
    for (const { path, methods } of endpoints) {
      if (DEVICE_FLOW_PATHS.has(path)) continue;
      for (const method of methods.length === 0 || methods.includes('*')
        ? ['GET', 'POST']
        : methods) {
        if (method !== 'GET' && method !== 'POST') continue;
        for (const credential of [device.token, patToken]) {
          const res = await ctx.app.request(path.replace(/:(\w+)/g, 'x'), {
            method,
            headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
            ...(method === 'POST' ? { body: '{}' } : {}),
          });
          expect(res.status, `${method} ${path}`).toBe(403);
          expect(((await res.json()) as { code: string }).code).toBe('forbidden_scope');
        }
      }
    }
    // The device flow endpoints ignore credentials entirely.
    expect((await deviceCode(ctx)).user_code).toBeTruthy();
  });

  it('rejects a device session sent as a cookie, on /api/auth and /api/v1', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const device = await deviceLogin(ctx, owner, {
      scopes: ['tasks:read'],
      constraints: { orgs: 'all' },
    });
    const { signCookieValue } = await import('../src/lib/tokens.ts');
    const { SESSION_COOKIE } = await import('../src/auth/cookies.ts');
    const cookie = `${SESSION_COOKIE}=${signCookieValue(TEST_ENV.ROOSTER_AUTH_SECRET, device.token)}`;
    const v1 = await ctx.app.request('/api/v1/me', { headers: { cookie } });
    expect(v1.status).toBe(401);
    const auth = await ctx.app.request('/api/auth/list-sessions', { headers: { cookie } });
    expect(auth.status).toBe(403);
    // The browser itself is unaffected.
    expect(
      (await ctx.app.request('/api/auth/get-session', { headers: { cookie: owner.jar.header() } }))
        .status,
    ).toBe(200);
  });

  it('rejects a browser session token used as a bearer token (401)', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const raw = ctx.db.orm.select().from(session).where(eq(session.userId, owner.userId)).get();
    expect(raw).toBeDefined();
    const res = await bearer(ctx, raw?.token ?? '').call('GET', '/api/v1/me');
    expect(res.status).toBe(401);
    const signed = decodeURIComponent(owner.jar.header().split('=').slice(1).join('='));
    expect((await bearer(ctx, signed).call('GET', '/api/v1/me')).status).toBe(401);
  });

  it('never exposes the session token in a set-auth-token header', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const res = await ctx.app.request('/api/auth/get-session', {
      headers: { cookie: owner.jar.header() },
    });
    expect(res.headers.get('set-auth-token')).toBeNull();
  });
});

describe('GET /tasks/resolve (07 §3)', () => {
  it('resolves numbers, org#number and ID prefixes; Trash only on request', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const a = await owner.ok<Task>('POST', '/api/v1/orgs/personal/tasks', { title: 'A' }, 201);
    const b = await owner.ok<Task>('POST', '/api/v1/orgs/personal/tasks', { title: 'B' }, 201);
    const resolve = (query: string) => owner.call('GET', `/api/v1/tasks/resolve?${query}`);
    expect(((await (await resolve(`ref=${a.seq}&org=personal`)).json()) as Task).id).toBe(a.id);
    expect(((await (await resolve(`ref=personal%23${b.seq}`)).json()) as Task).id).toBe(b.id);
    expect(((await (await resolve(`ref=${a.id.slice(0, 13)}`)).json()) as Task).id).toBe(a.id);
    expect(
      ((await (await resolve(`ref=${a.id.replace(/-/g, '').slice(0, 20)}`)).json()) as Task).id,
    ).toBe(a.id);
    expect((await resolve(`ref=${a.seq}`)).status).toBe(422);
    expect((await resolve('ref=zz')).status).toBe(422);
    // Both IDs share their first 8 hex digits (same millisecond range is likely but not
    // certain), so build the ambiguity from the common prefix.
    let common = '';
    while (a.id[common.length] === b.id[common.length]) common += a.id[common.length];
    const prefix = common.replace(/-/g, '');
    if (prefix.length >= 8) {
      const res = await resolve(`ref=${common}`);
      expect(res.status).toBe(409);
      const problem = (await res.json()) as { code: string; candidates: { id: string }[] };
      expect(problem.code).toBe('ambiguous_ref');
      expect(problem.candidates.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
    }
    await owner.ok('POST', `/api/v1/tasks/${a.id}/complete`, { completed: true });
    expect((await resolve(`ref=${a.seq}&org=personal`)).status).toBe(200);
    await owner.ok('DELETE', `/api/v1/tasks/${a.id}`, undefined, 204);
    expect((await resolve(`ref=${a.seq}&org=personal`)).status).toBe(404);
    const trashed = (await (
      await resolve(`ref=${a.seq}&org=personal&deleted=true`)
    ).json()) as Task;
    expect(trashed.deletedAt).toBeTypeOf('number');
  });

  it('is 404 for other users’ tasks and for tasks a grant cannot read', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const other = ctx.user('other@example.com');
    const prio = await groupNamed(owner, 'Prio');
    const today = await groupNamed(owner, 'Today');
    const hidden = await owner.ok<Task>(
      'POST',
      '/api/v1/orgs/personal/tasks',
      { title: 'H', groupId: today.id },
      201,
    );
    expect((await other.call('GET', `/api/v1/tasks/resolve?ref=${hidden.id}`)).status).toBe(404);
    const orgId = await personalOrgId(owner);
    const api = bearer(
      ctx,
      (
        await pat(owner, ['tasks:read'], {
          orgs: [{ orgId, read: { groups: [prio.id] }, write: 'none' }],
        })
      ).token,
    );
    expect(
      (await api.call('GET', `/api/v1/tasks/resolve?ref=${hidden.seq}&org=personal`)).status,
    ).toBe(404);
    expect((await api.call('GET', `/api/v1/tasks/resolve?ref=${hidden.id}`)).status).toBe(404);
  });
});

describe('SSE with a grant', () => {
  it('drops invalidations of orgs outside the grant', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const orgId = await personalOrgId(owner);
    const { grant } = await pat(owner, ['tasks:read'], {
      orgs: [{ orgId, read: 'all', write: 'none' }],
    });
    const row = ctx.db.orm.select().from(accessGrant).where(eq(accessGrant.id, grant.id)).get();
    expect(row).toBeDefined();
    const actor = ctx.app.services.grants.resolvePat(
      ctx.db.orm.select().from(apikey).get()?.key ?? '',
      null,
    );
    expect(actor?.grant?.id).toBe(grant.id);
    const access = ctx.app.services.grants.streamAccess(actor ?? owner.actor);
    expect(access.filterKeys?.(orgId, [['my-list', orgId]])).toEqual([['my-list', orgId]]);
    expect(access.filterKeys?.('0199a1b2-0000-7000-8000-000000000999', [['my-list', 'x']])).toEqual(
      [],
    );
    expect(access.filterKeys?.(null, [['me']])).toEqual([['me']]);
    expect(access.notification?.({ unreadCount: 1, notification: null })).toBeNull();
    expect(access.isValid()).toBe(true);
    await owner.ok('DELETE', `/api/v1/me/grants/${grant.id}`, undefined, 204);
    expect(access.isValid()).toBe(false);
    expect(ctx.app.services.grants.streamAccess(owner.actor).filterKeys).toBeUndefined();
  });
});

describe('rooster token create from a CLI device (07 §4)', () => {
  async function setup(approvalExpiry?: number) {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const orgId = await personalOrgId(owner);
    const prio = await groupNamed(owner, 'Prio');
    const constraints = { orgs: [{ orgId, read: 'all' as const, write: { groups: [prio.id] } }] };
    const device = await deviceLogin(ctx, owner, {
      scopes: ['tasks:write'],
      constraints,
      ...(approvalExpiry === undefined ? {} : { expiresInDays: approvalExpiry }),
    });
    return { ctx, owner, orgId, prio, constraints, device, cli: bearer(ctx, device.token) };
  }

  it('mints a PAT within the device grant, which outlives the device', async () => {
    const { ctx, owner, orgId, prio, cli, device } = await setup();
    const created = await cli.ok<TokenCreated>(
      'POST',
      '/api/v1/me/tokens',
      {
        name: 'CI',
        scopes: ['tasks:read'],
        constraints: { orgs: [{ orgId, read: { groups: [prio.id] }, write: 'none' }] },
        expiresInDays: 30,
      },
      201,
    );
    const row = ctx.db.orm
      .select()
      .from(accessGrant)
      .where(eq(accessGrant.id, created.grant.id))
      .get();
    expect(row?.createdByGrantId).toBe(device.grant.id);
    await cli.ok('DELETE', `/api/v1/me/grants/${device.grant.id}`, undefined, 204);
    await bearer(ctx, created.token).ok('GET', '/api/v1/orgs/personal/my-list');
    const listed = await owner.ok<Grant[]>('GET', '/api/v1/me/grants');
    expect(listed.map((g) => g.id)).toEqual([created.grant.id]);
  });

  it('rejects anything wider than the device grant with 422 widening_not_allowed', async () => {
    const { owner, orgId, prio, constraints, cli } = await setup(30);
    const today = await groupNamed(owner, 'Today');
    for (const body of [
      { scopes: ['tasks:delete'], constraints, expiresInDays: 7 },
      { scopes: ['tasks:read'], constraints: { orgs: 'all' }, expiresInDays: 7 },
      {
        scopes: ['tasks:write'],
        constraints: { orgs: [{ orgId, read: 'all', write: { groups: [prio.id, today.id] } }] },
        expiresInDays: 7,
      },
      { scopes: ['tasks:read'], constraints },
      { scopes: ['tasks:read'], constraints, expiresInDays: 60 },
    ]) {
      const problem = await cli.problem('POST', '/api/v1/me/tokens', { name: 'x', ...body }, 422);
      expect(problem.code, JSON.stringify(body)).toBe('widening_not_allowed');
    }
    await cli.ok(
      'POST',
      '/api/v1/me/tokens',
      { name: 'ok', scopes: ['tasks:read'], constraints, expiresInDays: 7 },
      201,
    );
  });

  it('does not let a PAT mint PATs', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const api = bearer(ctx, (await pat(owner, ALL)).token);
    const problem = await api.problem(
      'POST',
      '/api/v1/me/tokens',
      { name: 'x', scopes: ['tasks:read'], constraints: { orgs: 'all' } },
      403,
    );
    expect(problem.code).toBe('forbidden_scope');
  });
});

describe('notifications under a grant', () => {
  it('counts and streams only the orgs the grant reaches', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const bob = ctx.user('bob@example.com');
    const orgId = await personalOrgId(owner);
    const team = await bob.ok<{ id: string }>('POST', '/api/v1/orgs', { name: 'Team' }, 201);
    const { url } = await bob.ok<{ url: string }>(
      'POST',
      `/api/v1/orgs/${team.id}/invites`,
      { role: 'member' },
      201,
    );
    await owner.ok('POST', `/api/v1/invites/${url.split('/invite/')[1]}/accept`);
    // Bob assigns the owner a task in Team: one unread notification outside the grant.
    await bob.ok(
      'POST',
      `/api/v1/orgs/${team.id}/tasks`,
      { title: 'For you', assigneeId: owner.userId },
      201,
    );
    const browser = await owner.ok<{ unreadCount: number; items: unknown[] }>(
      'GET',
      '/api/v1/notifications',
    );
    expect(browser.unreadCount).toBe(1);
    const created = await pat(owner, ['notifications:read'], {
      orgs: [{ orgId, read: 'all', write: 'none' }],
    });
    const api = bearer(ctx, created.token);
    const page = await api.ok<{ unreadCount: number; items: unknown[] }>(
      'GET',
      '/api/v1/notifications',
    );
    expect(page).toMatchObject({ unreadCount: 0, items: [] });
    expect(
      (await api.ok<{ unreadCount: number }>('POST', '/api/v1/notifications/read', { all: true }))
        .unreadCount,
    ).toBe(0);
    const actor = ctx.app.services.grants.resolvePat(await defaultKeyHasher(created.token), null);
    const access = ctx.app.services.grants.streamAccess(actor ?? owner.actor);
    const preview = (org: string) => ({
      unreadCount: 7,
      notification: {
        id: org,
        orgId: org,
        type: 'assigned',
        taskId: null,
        actorName: 'Bob',
        title: 'x',
      },
    });
    expect(access.notification?.(preview(team.id))).toBeNull();
    expect(access.notification?.(preview(orgId))).toMatchObject({ unreadCount: 0 });
    expect(access.notification?.({ unreadCount: 7, notification: null })).toEqual({
      unreadCount: 0,
      notification: null,
    });
    expect(ctx.app.services.grants.streamAccess(owner.actor).notification).toBeUndefined();
  });
});

describe('device flow encodings (RFC 8628 §3.1, §3.4)', () => {
  it('accepts form-encoded and JSON bodies on both endpoints', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const form = (path: string, body: Record<string, string>) =>
      ctx.app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
      });
    const codeRes = await form('/api/auth/device/code', {
      client_id: 'rooster-cli',
      scope: 'tasks:read',
    });
    expect(codeRes.status, await codeRes.clone().text()).toBe(200);
    const code = (await codeRes.json()) as { device_code: string; user_code: string };
    const tokenBody = {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: code.device_code,
      client_id: 'rooster-cli',
    };
    const pending = await form('/api/auth/device/token', tokenBody);
    expect(pending.status).toBe(400);
    expect(((await pending.json()) as { error: string }).error).toBe('authorization_pending');
    await owner.ok('POST', `/api/v1/device/${code.user_code}/approve`, {
      scopes: ['tasks:read'],
      constraints: { orgs: 'all' },
    });
    ctx.db.sqlite.prepare('UPDATE deviceCode SET last_polled_at = 0').run();
    const token = await form('/api/auth/device/token', tokenBody);
    expect(token.status, await token.clone().text()).toBe(200);
    expect(((await token.json()) as { token_type: string }).token_type).toBe('Bearer');
    // JSON on both endpoints (deviceLogin above polls with JSON).
    const json = await deviceLogin(ctx, owner, {
      scopes: ['tasks:read'],
      constraints: { orgs: 'all' },
    });
    expect(json.token).toBeTruthy();
  });
});
