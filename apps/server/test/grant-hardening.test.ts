// Security review of Phases 6 and 8: regression tests for the grant boundary, notifications,
// SSE, the device flow and the collaboration fixes. Each `it` names the finding it covers.
import { defaultKeyHasher } from '@better-auth/api-key';
import type { Activity, Org, Task, TokenCreated } from '@rooster/core/schemas';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.ts';
import { deviceCode, follower, idempotency } from '../src/db/schema/index.ts';
import type { DomainEvent } from '../src/events/bus.ts';
import { ALL, bearer, pat } from './grant-helpers.ts';
import { groupNamed, type ListCtx, listCtx, meta, sharedOrg } from './list-helpers.ts';

/**
 * Owner and Bob in a shared org. The owner's task T sits in Prio; Bob's subtask S hangs under
 * it; the owner's orphan grandchild G (under S) sits in Today. A PAT limited to Prio cannot
 * reach G.
 */
async function tree() {
  const ctx = listCtx();
  const owner = ctx.user('owner@example.com');
  const bob = ctx.user('bob@example.com');
  const org = await sharedOrg(owner, [bob]);
  const prio = await groupNamed(owner, 'Prio', org.id);
  const today = await groupNamed(owner, 'Today', org.id);
  const t = await owner.ok<Task>(
    'POST',
    `/api/v1/orgs/${org.id}/tasks`,
    { title: 'T', groupId: prio.id },
    201,
  );
  const s = await bob.ok<Task>(
    'POST',
    `/api/v1/orgs/${org.id}/tasks`,
    { title: 'S', parentId: t.id, assigneeId: bob.userId },
    201,
  );
  const g = await owner.ok<Task>(
    'POST',
    `/api/v1/orgs/${org.id}/tasks`,
    { title: 'G', parentId: s.id, assigneeId: owner.userId },
    201,
  );
  await owner.ok('POST', `/api/v1/tasks/${g.id}/move`, { groupId: today.id });
  const prioOnly = (read: 'all' | 'prio' = 'all') => ({
    orgs: [
      {
        orgId: org.id,
        read: read === 'all' ? ('all' as const) : { groups: [prio.id] },
        write: { groups: [prio.id] },
      },
    ],
  });
  return { ctx, owner, bob, org, prio, today, t, s, g, prioOnly };
}

const code = async (res: Response) => ((await res.json()) as { code: string }).code;

async function actorOf(ctx: ListCtx, token: string) {
  const actor = ctx.app.services.grants.resolvePat(await defaultKeyHasher(token), null);
  if (actor === null) throw new Error('no actor');
  return actor;
}

function capture(ctx: ListCtx): DomainEvent[] {
  const events: DomainEvent[] = [];
  ctx.app.services.events.on((e) => events.push(e));
  return events;
}

describe('P8 grant boundary', () => {
  it('#1 a PAT cannot replay the browser’s Idempotency-Key (no token leaks)', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const body = { name: 'CI', scopes: ['tasks:read'], constraints: { orgs: 'all' } };
    const key = { 'idempotency-key': 'shared-key-1' };
    await owner.ok('POST', '/api/v1/me/tokens', body, 201, key);
    const reader = bearer(ctx, (await pat(owner, ['tasks:read'])).token);
    const replay = await reader.call('POST', '/api/v1/me/tokens', body, key);
    expect(replay.status).toBe(422);
    expect(await code(replay)).toBe('idempotency_key_reuse');
  });

  it('#1 a replay after the grant changed is 409 idempotency_stale', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const created = await pat(owner, ALL);
    const api = bearer(ctx, created.token);
    const key = { 'idempotency-key': 'stale-key-1' };
    const first = await api.call('POST', '/api/v1/orgs/personal/tasks', { title: 'x' }, key);
    expect(first.status).toBe(201);
    expect(
      (await api.call('POST', '/api/v1/orgs/personal/tasks', { title: 'x' }, key)).status,
    ).toBe(201);
    await owner.ok('PATCH', `/api/v1/me/grants/${created.grant.id}`, { scopes: ['tasks:read'] });
    const replay = await api.call('POST', '/api/v1/orgs/personal/tasks', { title: 'x' }, key);
    expect(replay.status).toBe(409);
    expect(await code(replay)).toBe('idempotency_stale');
  });

  it('#2 a new PAT is never stored for replay: 409 token_shown_once', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const body = { name: 'CI', scopes: ['tasks:read'], constraints: { orgs: 'all' } };
    const key = { 'idempotency-key': 'token-key-1' };
    const first = await owner.ok<TokenCreated>('POST', '/api/v1/me/tokens', body, 201, key);
    expect(first.token).toMatch(/^rooster_pat_/);
    const replay = await owner.call('POST', '/api/v1/me/tokens', body, key);
    expect(replay.status).toBe(409);
    expect(await code(replay)).toBe('token_shown_once');
    const stored = ctx.db.orm.select().from(idempotency).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.response).not.toContain('rooster_pat_');
  });

  it('#3 duplicate authorises every copied subtask and the existing-ID fast path', async () => {
    const { ctx, owner, t, prioOnly, today } = await tree();
    const api = bearer(ctx, (await pat(owner, ALL, prioOnly())).token);
    const res = await api.call('POST', `/api/v1/tasks/${t.id}/duplicate`, {});
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('outside_grant');
    // Nothing was copied.
    expect(ctx.db.sqlite.prepare("SELECT count(*) AS n FROM task WHERE title = 'T'").get()).toEqual(
      {
        n: 1,
      },
    );
    // The browser made a copy (in Today) with a client ID; the PAT may not fetch it by replay.
    const source = await owner.ok<Task>(
      'POST',
      `/api/v1/orgs/${t.orgId}/tasks`,
      { title: 'In Today', groupId: today.id },
      201,
    );
    const id = '0199aaaa-0000-7000-8000-00000000d001';
    await owner.ok('POST', `/api/v1/tasks/${source.id}/duplicate`, { id }, 201);
    const fast = await api.call('POST', `/api/v1/tasks/${source.id}/duplicate`, { id });
    expect(fast.status).toBe(403);
    expect(await code(fast)).toBe('outside_grant');
  });

  it('#4 a subtask is checked where it lands (own Inbox placement)', async () => {
    const { ctx, owner, s, prioOnly } = await tree();
    const api = bearer(ctx, (await pat(owner, ALL, prioOnly())).token);
    const res = await api.call('POST', `/api/v1/orgs/${s.orgId}/tasks`, {
      title: 'Mine',
      parentId: s.id,
      assigneeId: owner.userId,
    });
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('outside_grant');
    // Without choosing an assignee it inherits Bob's and stays in Bob's row: allowed.
    await api.ok('POST', `/api/v1/orgs/${s.orgId}/tasks`, { title: 'Bobs', parentId: s.id }, 201);
  });

  it('#5 a reassignment that moves a child placement out of the grant is rejected', async () => {
    const { ctx, owner, bob, org, prio, prioOnly } = await tree();
    const parent = await owner.ok<Task>(
      'POST',
      `/api/v1/orgs/${org.id}/tasks`,
      { title: 'P', groupId: prio.id },
      201,
    );
    // A child of mine inside my row: no placement of its own.
    const child = await owner.ok<Task>(
      'POST',
      `/api/v1/orgs/${org.id}/tasks`,
      { title: 'C', parentId: parent.id },
      201,
    );
    expect(child.placement).toBeNull();
    const api = bearer(ctx, (await pat(owner, ALL, prioOnly())).token);
    // Giving P to Bob would orphan C into my Inbox.
    const res = await api.call('PATCH', `/api/v1/tasks/${parent.id}`, { assigneeId: bob.userId });
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('outside_grant');
    const after = await owner.ok<Task>('GET', `/api/v1/tasks/${parent.id}`);
    expect(after.assigneeId).toBe(owner.userId);
  });

  it('#6 delete, restore and permanent delete check the whole subtree', async () => {
    const { ctx, owner, t, prioOnly } = await tree();
    const api = bearer(ctx, (await pat(owner, ALL, prioOnly())).token);
    const del = await api.call('DELETE', `/api/v1/tasks/${t.id}`);
    expect(del.status).toBe(403);
    expect(await code(del)).toBe('outside_grant');
    expect((await owner.ok<Task>('GET', `/api/v1/tasks/${t.id}`)).deletedAt).toBeUndefined();
    await owner.ok('DELETE', `/api/v1/tasks/${t.id}`, undefined, 204);
    const restore = await api.call('POST', `/api/v1/tasks/${t.id}/restore`);
    expect(restore.status).toBe(403);
    const purge = await api.call('DELETE', `/api/v1/tasks/${t.id}/permanent`);
    expect(purge.status).toBe(403);
    expect(await code(purge)).toBe('outside_grant');
  });

  it('#7 notifications apply task readability to list, count, mark and SSE previews', async () => {
    const { ctx, owner, bob, org, prioOnly } = await tree();
    // Bob gives the owner a task: it lands in the owner's Inbox, outside the read constraint.
    const given = await bob.ok<Task>(
      'POST',
      `/api/v1/orgs/${org.id}/tasks`,
      { title: 'For you', assigneeId: owner.userId },
      201,
    );
    const browser = await owner.ok<{ unreadCount: number; items: { id: string }[] }>(
      'GET',
      '/api/v1/notifications',
    );
    const unread = browser.unreadCount;
    expect(unread).toBeGreaterThan(0);
    const created = await pat(owner, ['tasks:read', 'notifications:read'], prioOnly('prio'));
    const api = bearer(ctx, created.token);
    const page = await api.ok<{ unreadCount: number; items: { taskId: string | null }[] }>(
      'GET',
      '/api/v1/notifications',
    );
    expect(page.items.map((i) => i.taskId)).not.toContain(given.id);
    const hidden = browser.items.length - page.items.length;
    expect(hidden).toBeGreaterThan(0);
    await api.ok('POST', '/api/v1/notifications/read', { all: true });
    await api.ok('POST', '/api/v1/notifications/read', { ids: browser.items.map((i) => i.id) });
    const still = await owner.ok<{ unreadCount: number }>('GET', '/api/v1/notifications');
    expect(still.unreadCount).toBe(hidden);
    const access = ctx.app.services.grants.streamAccess(await actorOf(ctx, created.token));
    expect(
      access.notification?.({
        unreadCount: 9,
        notification: {
          id: given.id,
          orgId: org.id,
          type: 'assigned',
          taskId: given.id,
          actorName: 'Bob',
          title: 'For you',
        },
      }),
    ).toBeNull();
  });

  it('#8 SSE keys are filtered per task and per scope for grant streams', async () => {
    const { ctx, owner, org, t, g, prioOnly } = await tree();
    const reader = await pat(owner, ['tasks:read'], prioOnly('prio'));
    const access = ctx.app.services.grants.streamAccess(await actorOf(ctx, reader.token));
    const keys = [
      ['task', t.id],
      ['task', g.id],
      ['activity', g.id],
      ['my-list', org.id],
      ['org-invites', org.id],
      ['notifications'],
    ];
    // G was never readable: nothing about it (round 4).
    expect(access.filterKeys?.(org.id, keys)).toEqual([
      ['task', t.id],
      ['my-list', org.id],
    ]);
    const inboxOnly = await pat(owner, ['notifications:read']);
    const noTasks = ctx.app.services.grants.streamAccess(await actorOf(ctx, inboxOnly.token));
    expect(noTasks.filterKeys?.(org.id, keys)).toEqual([['notifications']]);
  });

  it('#9 the activity feed leaves out entries naming unreadable tasks', async () => {
    const { ctx, owner, s, g, prioOnly } = await tree();
    const all = await owner.ok<{ items: { activity?: Activity }[] }>(
      'GET',
      `/api/v1/tasks/${s.id}/activity`,
    );
    const names = (items: { activity?: Activity }[]) =>
      items
        .filter((i) => i.activity?.type === 'subtask_added')
        .map((i) => (i.activity?.data as { subtaskId?: string } | undefined)?.subtaskId);
    expect(names(all.items)).toContain(g.id);
    const api = bearer(ctx, (await pat(owner, ['tasks:read'], prioOnly('prio'))).token);
    const feed = await api.ok<{ items: { activity?: Activity }[] }>(
      'GET',
      `/api/v1/tasks/${s.id}/activity`,
    );
    expect(names(feed.items)).not.toContain(g.id);
  });

  it('#10 resolve applies the read filter before its scan limit', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const prio = await groupNamed(owner, 'Prio');
    const today = await groupNamed(owner, 'Today');
    for (let i = 1; i <= 205; i++) {
      ctx.app.services.tasks.create(owner.actor, 'personal', {
        id: `0199aaaa-0000-7000-8000-${i.toString(16).padStart(12, '0')}`,
        title: `Hidden ${i}`,
        groupId: today.id,
      });
    }
    const wanted = ctx.app.services.tasks.create(owner.actor, 'personal', {
      id: '0199aaaa-0000-7000-8000-000000000fff',
      title: 'Visible',
      groupId: prio.id,
    });
    const orgId = wanted.orgId;
    const api = bearer(
      ctx,
      (
        await pat(owner, ['tasks:read'], {
          orgs: [{ orgId, read: { groups: [prio.id] }, write: 'none' }],
        })
      ).token,
    );
    const found = await api.ok<Task>('GET', '/api/v1/tasks/resolve?ref=0199aaaa');
    expect(found.id).toBe(wanted.id);
  });

  it('#11 a PAT marking read broadcasts the user’s whole unread count', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const bob = ctx.user('bob@example.com');
    const a = await sharedOrg(owner, [bob], 'A');
    const b = await sharedOrg(owner, [bob], 'B');
    await bob.ok(
      'POST',
      `/api/v1/orgs/${a.id}/tasks`,
      { title: 'a', assigneeId: owner.userId },
      201,
    );
    await bob.ok(
      'POST',
      `/api/v1/orgs/${b.id}/tasks`,
      { title: 'b', assigneeId: owner.userId },
      201,
    );
    const before = await owner.ok<{ unreadCount: number }>('GET', '/api/v1/notifications');
    const onlyA = await pat(owner, ['notifications:read'], {
      orgs: [{ orgId: a.id, read: 'all', write: 'none' }],
    });
    const events = capture(ctx);
    const res = await bearer(ctx, onlyA.token).ok<{ unreadCount: number }>(
      'POST',
      '/api/v1/notifications/read',
      { all: true },
    );
    expect(res.unreadCount).toBe(0);
    const sent = events.find((e) => e.type === 'notification.read')?.direct?.[0]?.data as {
      unreadCount: number;
    };
    const after = await owner.ok<{ unreadCount: number }>('GET', '/api/v1/notifications');
    expect(after.unreadCount).toBeGreaterThan(0);
    expect(after.unreadCount).toBeLessThan(before.unreadCount);
    expect(sent.unreadCount).toBe(after.unreadCount);
  });

  it('#12 device code scopes are bounded and stored canonical; expired codes are purged', async () => {
    const ctx = listCtx();
    const request = (scope: string) =>
      ctx.app.request('/api/auth/device/code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: 'rooster-cli', scope }),
      });
    const ok = await request('tasks:write  tasks:read tasks:write');
    expect(ok.status).toBe(200);
    expect(ctx.db.orm.select().from(deviceCode).get()?.scope).toBe('tasks:read tasks:write');
    const long = await request('tasks:read '.repeat(50));
    expect(long.status).toBe(400);
    expect(((await long.json()) as { error: string }).error).toBe('invalid_scope');
    ctx.db.orm
      .update(deviceCode)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .run();
    expect(ctx.app.services.retention.purge().deviceCodes).toBe(1);
    expect(ctx.db.orm.select().from(deviceCode).all()).toEqual([]);
  });
});

describe('P6 server fixes', () => {
  async function team() {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const bob = ctx.user('bob@example.com');
    const org: Org = await sharedOrg(owner, [bob]);
    return { ctx, owner, bob, org };
  }

  it('#13 an assignee edit advances the clock even when the value is unchanged', async () => {
    const { ctx, owner, bob, org } = await team();
    const { tasks } = ctx.app.services;
    const t = tasks.create(owner.actor, org.id, { title: 'T' });
    tasks.patch(owner.actor, t.id, { assigneeId: owner.userId }, meta(2_000));
    const stale = tasks.patch(owner.actor, t.id, { assigneeId: bob.userId }, meta(1_000));
    expect(stale.ignoredFields).toEqual(['assigneeId']);
    expect(stale.task.assigneeId).toBe(owner.userId);
  });

  it('#13 a stale assignment to a departed member is ignored, not a 422', async () => {
    const { ctx, owner, bob, org } = await team();
    const { tasks } = ctx.app.services;
    const t = tasks.create(owner.actor, org.id, { title: 'T' });
    tasks.patch(owner.actor, t.id, { assigneeId: owner.userId }, meta(2_000));
    await owner.ok('DELETE', `/api/v1/orgs/${org.id}/members/${bob.userId}`, undefined, 204);
    const result = tasks.patch(
      owner.actor,
      t.id,
      { assigneeId: bob.userId, title: 'Renamed' },
      meta(1_000),
    );
    expect(result.ignoredFields).toEqual(['assigneeId']);
    expect(result.task.title).toBe('Renamed');
  });

  it('#14 migration 0008 backfills creator and assignee followers, keeping muted rows', async () => {
    const { ctx, owner, bob, org } = await team();
    const t = await owner.ok<Task>(
      'POST',
      `/api/v1/orgs/${org.id}/tasks`,
      { title: 'Old', assigneeId: bob.userId },
      201,
    );
    const personal = await owner.ok<Task>(
      'POST',
      '/api/v1/orgs/personal/tasks',
      { title: 'P' },
      201,
    );
    ctx.db.orm.delete(follower).run();
    ctx.db.orm.insert(follower).values({ taskId: t.id, userId: owner.userId, muted: true }).run();
    ctx.db.orm
      .insert(idempotency)
      .values({
        opId: 'k',
        userId: owner.userId,
        status: 201,
        response: '{"fp":"x","ct":null,"body":"{\\"token\\":\\"rooster_pat_abc\\"}"}',
        createdAt: Date.now(),
      })
      .run();
    ctx.db.sqlite
      .prepare(
        'DELETE FROM __drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM __drizzle_migrations)',
      )
      .run();
    runMigrations(ctx.db);
    const rows = ctx.db.orm.select().from(follower).all();
    expect(rows).toEqual(
      expect.arrayContaining([
        { taskId: t.id, userId: owner.userId, muted: true },
        { taskId: t.id, userId: bob.userId, muted: false },
      ]),
    );
    expect(rows.some((r) => r.taskId === personal.id)).toBe(false);
    expect(ctx.db.orm.select().from(idempotency).all()).toEqual([]);
  });

  it('#15 a permanent delete refreshes the inboxes its notifications vanish from', async () => {
    const { ctx, owner, bob, org } = await team();
    const t = await owner.ok<Task>(
      'POST',
      `/api/v1/orgs/${org.id}/tasks`,
      { title: 'For Bob', assigneeId: bob.userId },
      201,
    );
    expect(
      (await bob.ok<{ unreadCount: number }>('GET', '/api/v1/notifications')).unreadCount,
    ).toBe(1);
    await owner.ok('DELETE', `/api/v1/tasks/${t.id}`, undefined, 204);
    const events = capture(ctx);
    await owner.ok('DELETE', `/api/v1/tasks/${t.id}/permanent`, undefined, 204);
    const toBob = events.flatMap((e) =>
      e.audiences.filter((a) => a.userIds.includes(bob.userId)).flatMap((a) => a.keys),
    );
    expect(toBob).toContainEqual(['notifications']);
    const direct = events.flatMap((e) => e.direct ?? []).find((d) => d.userId === bob.userId);
    expect(direct?.data).toEqual({ unreadCount: 0, notification: null });
  });

  it('#16 removing a member invalidates the tasks they followed', async () => {
    const { ctx, owner, bob, org } = await team();
    const t = await owner.ok<Task>('POST', `/api/v1/orgs/${org.id}/tasks`, { title: 'T' }, 201);
    await bob.ok('PUT', `/api/v1/tasks/${t.id}/followers/me`);
    const events = capture(ctx);
    await owner.ok('DELETE', `/api/v1/orgs/${org.id}/members/${bob.userId}`, undefined, 204);
    const keys = events
      .filter((e) => e.type === 'task.followed')
      .flatMap((e) => e.audiences.flatMap((a) => a.keys));
    expect(keys).toContainEqual(['task', t.id]);
    expect(ctx.db.orm.select().from(follower).where(eq(follower.userId, bob.userId)).all()).toEqual(
      [],
    );
  });
});

describe('review round 3', () => {
  it('R1 a restore whose task lands outside the grant (parent in Trash, group gone) rolls back', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const prio = await groupNamed(owner, 'Prio');
    const extra = await owner.ok<{ group: { id: string; orgId: string } }>(
      'POST',
      '/api/v1/orgs/personal/groups',
      { name: 'Extra' },
      201,
    );
    const orgId = extra.group.orgId;
    const api = bearer(
      ctx,
      (
        await pat(owner, ALL, {
          orgs: [{ orgId, read: 'all', write: { groups: [prio.id, extra.group.id] } }],
        })
      ).token,
    );
    // A subtask deleted on its own, then its parent: restoring it alone makes it top-level,
    // in the owner's Inbox.
    const parent = await owner.ok<Task>(
      'POST',
      '/api/v1/orgs/personal/tasks',
      { title: 'P', groupId: prio.id },
      201,
    );
    const child = await owner.ok<Task>(
      'POST',
      '/api/v1/orgs/personal/tasks',
      { title: 'C', parentId: parent.id },
      201,
    );
    await owner.ok('DELETE', `/api/v1/tasks/${child.id}`, undefined, 204);
    await owner.ok('DELETE', `/api/v1/tasks/${parent.id}`, undefined, 204);
    const res = await api.call('POST', `/api/v1/tasks/${child.id}/restore`);
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('outside_grant');
    expect((await owner.ok<Task>('GET', `/api/v1/tasks/${child.id}`)).deletedAt).toBeTypeOf(
      'number',
    );
    // A task whose group was deleted meanwhile is re-homed to the Inbox: same.
    const x = await owner.ok<Task>(
      'POST',
      '/api/v1/orgs/personal/tasks',
      { title: 'X', groupId: extra.group.id },
      201,
    );
    await owner.ok('DELETE', `/api/v1/tasks/${x.id}`, undefined, 204);
    await owner.ok('DELETE', `/api/v1/groups/${extra.group.id}`, {}, 204);
    const bulk = await api.ok<{ results: { id: string; ok: boolean; code?: string }[] }>(
      'POST',
      '/api/v1/tasks/bulk',
      { op: 'restore', ids: [x.id] },
    );
    expect(bulk.results).toEqual([{ id: x.id, ok: false, code: 'outside_grant' }]);
    expect((await owner.ok<Task>('GET', `/api/v1/tasks/${x.id}`)).deletedAt).toBeTypeOf('number');
  });

  it('R2 search filters readability before its limit', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const prio = await groupNamed(owner, 'Prio');
    const today = await groupNamed(owner, 'Today');
    for (let i = 0; i < 3; i++) {
      await owner.ok(
        'POST',
        '/api/v1/orgs/personal/tasks',
        { title: 'alpha', groupId: today.id },
        201,
      );
    }
    const visible = await owner.ok<Task>(
      'POST',
      '/api/v1/orgs/personal/tasks',
      { title: 'alpha', groupId: prio.id },
      201,
    );
    const api = bearer(
      ctx,
      (
        await pat(owner, ['tasks:read'], {
          orgs: [{ orgId: visible.orgId, read: { groups: [prio.id] }, write: 'none' }],
        })
      ).token,
    );
    const hits = await api.ok<{ task: Task }[]>('GET', '/api/v1/search?q=alpha&limit=1');
    expect(hits.map((h) => h.task.id)).toEqual([visible.id]);
  });

  it('R3 a task key the grant could read before becomes the bare prefix; never-readable ones are dropped', async () => {
    const { ctx, owner, org, prio, today, g, prioOnly } = await tree();
    const reader = await pat(owner, ['tasks:read'], prioOnly('prio'));
    const access = ctx.app.services.grants.streamAccess(await actorOf(ctx, reader.token));
    const keysOf = (e: DomainEvent) =>
      access.filterKeys?.(
        org.id,
        e.audiences.filter((a) => a.org === org.id).flatMap((a) => a.keys),
        e.priorGroups,
      );
    // Never readable: keys about G go nowhere, even with the event's prior groups.
    expect(
      access.filterKeys?.(org.id, [
        ['task', g.id],
        ['activity', g.id],
      ]),
    ).toEqual([]);
    const x = await owner.ok<Task>(
      'POST',
      `/api/v1/orgs/${org.id}/tasks`,
      { title: 'X', groupId: prio.id },
      201,
    );
    // Moved out of the readable group: the bare prefix.
    const events = capture(ctx);
    await owner.ok('POST', `/api/v1/tasks/${x.id}/move`, { groupId: today.id });
    const moved = events.find((e) => e.type === 'task.moved');
    expect(moved).toBeDefined();
    expect(keysOf(moved as DomainEvent)).toEqual([['my-list', org.id], ['task']]);
    // Purged while readable: the bare prefix too.
    await owner.ok('POST', `/api/v1/tasks/${x.id}/move`, { groupId: prio.id });
    await owner.ok('DELETE', `/api/v1/tasks/${x.id}`, undefined, 204);
    events.length = 0;
    await owner.ok('DELETE', `/api/v1/tasks/${x.id}/permanent`, undefined, 204);
    const purged = events.find((e) => e.type === 'task.purged');
    expect(keysOf(purged as DomainEvent)).toContainEqual(['task']);
    expect(keysOf(purged as DomainEvent)).not.toContainEqual(['task', x.id]);
  });

  it('R3 another member unfollowing their own task outside the grant sends nothing', async () => {
    const { ctx, owner, bob, org, prioOnly } = await tree();
    const theirs = await bob.ok<Task>('POST', `/api/v1/orgs/${org.id}/tasks`, { title: 'B' }, 201);
    const reader = await pat(owner, ['tasks:read'], prioOnly('prio'));
    const access = ctx.app.services.grants.streamAccess(await actorOf(ctx, reader.token));
    const events = capture(ctx);
    await bob.ok('DELETE', `/api/v1/tasks/${theirs.id}/followers/me`);
    const followed = events.find((e) => e.type === 'task.followed');
    expect(followed).toBeDefined();
    const keys = (followed as DomainEvent).audiences.flatMap((a) => a.keys);
    expect(keys).toContainEqual(['task', theirs.id]);
    expect(access.filterKeys?.(org.id, keys, followed?.priorGroups)).toEqual([]);
  });

  it('R2 restricted search stays fast with tens of thousands of hidden matches', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const prio = await groupNamed(owner, 'Prio');
    const visible = await owner.ok<Task>(
      'POST',
      '/api/v1/orgs/personal/tasks',
      { title: 'needle', groupId: prio.id },
      201,
    );
    // 30,000 hidden matches: unassigned tasks, outside every group of the owner's list.
    const insert = ctx.db.sqlite.prepare(
      "INSERT INTO task (id, org_id, title, created_by, created_at, updated_at) VALUES (?, ?, 'needle', ?, ?, ?)",
    );
    ctx.db.sqlite.transaction(() => {
      for (let i = 0; i < 30_000; i++) {
        insert.run(
          `0199aaaa-0000-7000-8000-${i.toString(16).padStart(12, '0')}`,
          visible.orgId,
          owner.userId,
          i,
          i,
        );
      }
    })();
    ctx.app.services.search.rebuild();
    const api = bearer(
      ctx,
      (
        await pat(owner, ['tasks:read'], {
          orgs: [{ orgId: visible.orgId, read: { groups: [prio.id] }, write: 'none' }],
        })
      ).token,
    );
    await api.ok('GET', '/api/v1/search?q=needle&limit=1');
    const started = performance.now();
    const hits = await api.ok<{ task: Task }[]>('GET', '/api/v1/search?q=needle&limit=1');
    const elapsed = performance.now() - started;
    expect(hits.map((h) => h.task.id)).toEqual([visible.id]);
    expect(elapsed).toBeLessThan(200);
  });

  it('R4 a grant marks more notifications than SQLite allows bound parameters', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const orgId = (
      await owner.ok<{ orgs: { id: string; isPersonal: boolean }[] }>('GET', '/api/v1/me')
    ).orgs.find((o) => o.isPersonal)?.id;
    const insert = ctx.db.sqlite.prepare(
      "INSERT INTO notification (id, user_id, org_id, type, data, created_at) VALUES (?, ?, ?, 'mention', '{}', ?)",
    );
    const many = 33_500;
    ctx.db.sqlite.transaction(() => {
      for (let i = 0; i < many; i++) {
        insert.run(
          `0199aaaa-0000-7000-8000-${i.toString(16).padStart(12, '0')}`,
          owner.userId,
          orgId,
          i,
        );
      }
    })();
    const api = bearer(ctx, (await pat(owner, ['notifications:read'])).token);
    const res = await api.ok<{ unreadCount: number }>('POST', '/api/v1/notifications/read', {
      all: true,
    });
    expect(res.unreadCount).toBe(0);
    expect(
      ctx.db.sqlite.prepare('SELECT count(*) AS n FROM notification WHERE read_at IS NULL').get(),
    ).toEqual({ n: 0 });
  });
});
