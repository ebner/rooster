// WP 4.3: domain events after commit, the SSE hub (targeting, coalescing, hello, heartbeat,
// stream lifetime) and its graceful-shutdown integration.
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import type { Problem, Tag, Task } from '@rooster/core/schemas';
import { SSE_HEARTBEAT_MS } from '@rooster/core/schemas';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { session } from '../src/db/schema/index.ts';
import type { DomainEvent } from '../src/events/bus.ts';
import { compactKeys, SSE_MAX_PER_SESSION, SSE_MAX_PER_USER } from '../src/events/hub.ts';
import { trackConnections } from '../src/lib/graceful-close.ts';
import { afterCommit, immediate } from '../src/services/context.ts';
import { addSession, BASE_URL, CookieJar, TEST_ENV } from './helpers.ts';
import { type Caller, createTask, listCtx, sharedOrg } from './list-helpers.ts';
import { SseClient, until } from './sse-client.ts';

const COALESCE_MS = 15;
const settle = () => new Promise((resolve) => setTimeout(resolve, COALESCE_MS * 4));

const open: SseClient[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(open.splice(0).map((c) => c.close()));
});

function ctx() {
  return listCtx({ sse: { coalesceMs: COALESCE_MS } });
}

async function listen(c: Caller, headers: Record<string, string> = {}): Promise<SseClient> {
  const res = await c.call('GET', '/api/v1/events', undefined, headers);
  expect(res.status).toBe(200);
  const client = new SseClient(res);
  open.push(client);
  await until(() => client.hello !== undefined, 1_000, 'hello');
  return client;
}

/** Three users: `a` owns a shared org with member `b`; `c` is not a member. */
async function trio() {
  const t = ctx();
  const a = t.user('a@example.com', 'Ann');
  const b = t.user('b@example.com', 'Bo');
  const c = t.user('c@example.com', 'Cy');
  const org = await sharedOrg(a, [b]);
  return { ...t, a, b, c, org };
}

describe('domain events are published after commit only', () => {
  it('afterCommit callbacks run after COMMIT and are dropped on rollback', () => {
    const { db } = ctx();
    const seen: boolean[] = [];
    immediate(db, (tx) => {
      afterCommit(tx, () => seen.push(db.sqlite.inTransaction));
    });
    expect(seen).toEqual([false]);
    expect(() =>
      immediate(db, (tx) => {
        afterCommit(tx, () => seen.push(true));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(seen).toEqual([false]);
  });

  it('a service that fails after queueing its event publishes nothing', async () => {
    const { app, a, org } = await trio();
    const events: DomainEvent[] = [];
    app.services.events.on((e) => events.push(e));
    // revokeInvite queues `invite.revoked` before it finds out the invite does not exist.
    const res = await a.call(
      'DELETE',
      `/api/v1/orgs/${org.id}/invites/0199aaaa-0000-7000-8000-000000000000`,
    );
    expect(res.status).toBe(404);
    expect(events).toEqual([]);
    // A failing bulk item rolls back alone: only the good one is published.
    const task = await createTask(a, { title: 'Good' }, org.id);
    events.length = 0;
    await a.ok('POST', '/api/v1/tasks/bulk', {
      op: 'complete',
      ids: [task.id, '0199aaaa-0000-7000-8000-000000000001'],
    });
    expect(events.map((e) => [e.type, e.subjects])).toEqual([['task.completed', [task.id]]]);
  });

  it('every event carries org, actor, origin and audiences', async () => {
    const { app, a, org } = await trio();
    const events: DomainEvent[] = [];
    app.services.events.on((e) => events.push(e));
    const task = await a.ok<Task>('POST', `/api/v1/orgs/${org.id}/tasks`, { title: 'T' }, 201, {
      'X-Rooster-Client-Id': 'tab-1',
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'task.created',
      orgId: org.id,
      actorId: a.userId,
      origin: 'tab-1',
      subjects: [task.id],
    });
  });
});

describe('GET /api/v1/events', () => {
  it('streams hello first, with proxy-safe headers and monotonic ids', async () => {
    const t = listCtx({ env: { ROOSTER_GIT_SHA: 'abc1234' }, clock: () => 1_767_225_600_000 });
    const a = t.user('a@example.com');
    const client = await listen(a);
    const { headers } = client.response;
    expect(headers.get('content-type')).toBe('text/event-stream');
    expect(headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(headers.get('x-accel-buffering')).toBe('no');
    expect(client.frames[0]).toEqual({
      event: 'hello',
      id: expect.any(Number),
      data: { version: '0.0.0-test', gitSha: 'abc1234', serverTime: 1_767_225_600_000 },
    });
    const second = await listen(a);
    expect(second.frames[0]?.id).toBeGreaterThan(client.frames[0]?.id ?? Infinity);
  });

  it('is 401 without a session', async () => {
    const { app } = ctx();
    const res = await app.request('/api/v1/events');
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
  });

  it('targets task changes: assignee and actor get my-list, members get the task, others nothing', async () => {
    const { a, b, c, org } = await trio();
    const [sa, sb, sc] = [await listen(a), await listen(b), await listen(c)];

    const task = await createTask(a, { title: 'Shared' }, org.id);
    await sa.waitFor(1);
    await sb.waitFor(1);
    await settle();
    expect(sa.invalidations).toHaveLength(1);
    expect(sa.invalidations[0]).toMatchObject({ org: org.id, origin: null });
    expect(new Set(sa.keys)).toEqual(new Set([`my-list/${org.id}`, `task/${task.id}`]));
    expect(sb.keys).toEqual([`task/${task.id}`]);
    expect(sc.invalidations).toEqual([]);

    // B (a member, not the assignee) completes it: the assignee's list and B's own list.
    await b.ok('POST', `/api/v1/tasks/${task.id}/complete`, { completed: true }, 200, {
      'X-Rooster-Client-Id': 'b-tab',
    });
    await sa.waitFor(2);
    await sb.waitFor(2);
    await settle();
    // The origin (B's client id) goes to B only: other people never learn it.
    for (const [s, origin] of [
      [sa, null],
      [sb, 'b-tab'],
    ] as const) {
      const last = s.invalidations.at(-1);
      expect(last?.origin).toBe(origin);
      expect(last?.keys).toEqual(
        expect.arrayContaining([
          ['my-list', org.id],
          ['task', task.id],
        ]),
      );
    }
    expect(sc.invalidations).toEqual([]);
  });

  it('subtask changes reach whoever has the parent in their list', async () => {
    const { a, b, org } = await trio();
    const parent = await createTask(a, { title: 'Parent' }, org.id);
    const sub = await createTask(a, { title: 'Sub', parentId: parent.id }, org.id);
    const [sa, sb] = [await listen(a), await listen(b)];
    await b.ok('PATCH', `/api/v1/tasks/${sub.id}`, { title: 'Renamed' });
    await sa.waitFor(1);
    await settle();
    expect(sa.keys).toEqual(
      expect.arrayContaining([`my-list/${org.id}`, `task/${sub.id}`, `task/${parent.id}`]),
    );
    expect(sb.keys).toContain(`my-list/${org.id}`);
  });

  it('personal state (groups, expansion, sidebar, settings) reaches only its owner', async () => {
    const { a, b, org } = await trio();
    const task = await createTask(a, { title: 'T' }, org.id);
    const [sa, sb] = [await listen(a), await listen(b)];
    await a.ok('POST', `/api/v1/orgs/${org.id}/groups`, { name: 'Mine' }, 201);
    await a.ok('PUT', `/api/v1/tasks/${task.id}/expanded`, undefined, 204);
    await a.ok('PATCH', `/api/v1/me/orgs/${org.id}`, { collapsed: true });
    await a.ok('PATCH', '/api/v1/me', { timezone: 'Europe/Stockholm' });
    await sa.waitFor(1);
    await settle();
    expect(new Set(sa.keys)).toEqual(new Set([`my-list/${org.id}`, 'orgs', 'me']));
    expect(sb.invalidations).toEqual([]);
  });

  it('tags go to every member: tags, my-list and the tagged tasks', async () => {
    const { a, b, c, org } = await trio();
    const task = await createTask(a, { title: 'T' }, org.id);
    const tag = await a.ok<Tag>('POST', `/api/v1/orgs/${org.id}/tags`, { name: 'Red' }, 201);
    await a.ok('PUT', `/api/v1/tasks/${task.id}/tags/${tag.id}`);
    const [sa, sb, sc] = [await listen(a), await listen(b), await listen(c)];
    await b.ok('DELETE', `/api/v1/tags/${tag.id}`, undefined, 204);
    await sa.waitFor(1);
    await sb.waitFor(1);
    await settle();
    for (const s of [sa, sb]) {
      expect(new Set(s.keys)).toEqual(
        new Set([`tags/${org.id}`, `my-list/${org.id}`, `task/${task.id}`]),
      );
    }
    expect(sc.invalidations).toEqual([]);
  });

  it('coalesces a burst into one event per stream and origin', async () => {
    const { a, org } = await trio();
    const ids = [];
    for (const title of ['1', '2', '3']) ids.push((await createTask(a, { title }, org.id)).id);
    const sa = await listen(a);
    await a.ok('POST', '/api/v1/tasks/bulk', { op: 'complete', ids }, 200, {
      'X-Rooster-Client-Id': 'tab-1',
    });
    await sa.waitFor(1);
    await settle();
    expect(sa.invalidations).toHaveLength(1);
    expect(sa.invalidations[0]?.origin).toBe('tab-1');
    expect(new Set(sa.keys)).toEqual(
      new Set([`my-list/${org.id}`, ...ids.map((id) => `task/${id}`)]),
    );

    // Two origins within one window stay separate, so each tab can skip its own.
    await a.ok('PATCH', `/api/v1/tasks/${ids[0]}`, { title: 'x' }, 200, {
      'X-Rooster-Client-Id': 'tab-1',
    });
    await a.ok('PATCH', `/api/v1/tasks/${ids[1]}`, { title: 'y' }, 200, {
      'X-Rooster-Client-Id': 'tab-2',
    });
    await sa.waitFor(3);
    await settle();
    expect(sa.invalidations.slice(1).map((i) => i.origin)).toEqual(['tab-1', 'tab-2']);
  });

  it('follows membership: a removed member is told once, then hears nothing; a joiner hears', async () => {
    const { a, b, c, org } = await trio();
    const [sa, sb, sc] = [await listen(a), await listen(b), await listen(c)];
    await a.ok('DELETE', `/api/v1/orgs/${org.id}/members/${b.userId}`, undefined, 204);
    await sb.waitFor(1);
    await sa.waitFor(1);
    await settle();
    expect(new Set(sb.keys)).toEqual(new Set(['orgs', 'me', `org-members/${org.id}`]));
    expect(sa.keys).toContain(`org-members/${org.id}`);

    const { url } = await a.ok<{ url: string }>(
      'POST',
      `/api/v1/orgs/${org.id}/invites`,
      { role: 'member' },
      201,
    );
    await c.ok('POST', `/api/v1/invites/${url.split('/invite/')[1]}/accept`);
    await sc.waitFor(1);
    expect(sc.keys).toEqual(expect.arrayContaining(['orgs', 'me', `org-members/${org.id}`]));

    const before = sb.invalidations.length;
    const task = await createTask(a, { title: 'After' }, org.id);
    await until(() => sc.keys.includes(`task/${task.id}`));
    await settle();
    expect(sb.invalidations).toHaveLength(before);
  });

  it('sends a heartbeat comment every SSE_HEARTBEAT_MS', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { a } = await trio();
    const sa = await listen(a);
    expect(sa.comments).toEqual([]);
    vi.advanceTimersByTime(SSE_HEARTBEAT_MS - 1);
    await settle();
    expect(sa.comments).toEqual([]);
    vi.advanceTimersByTime(1);
    await until(() => sa.comments.length === 1);
    vi.advanceTimersByTime(SSE_HEARTBEAT_MS);
    await until(() => sa.comments.length === 2);
    expect(sa.comments).toEqual(['ping', 'ping']);
    expect(sa.closed).toBe(false);
  });

  it('closes a stream at the next heartbeat when its session vanished without an event', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { app, db, a } = await trio();
    const sa = await listen(a);
    db.orm.delete(session).where(eq(session.id, a.actor.sessionId)).run();
    vi.advanceTimersByTime(SSE_HEARTBEAT_MS);
    await sa.waitClosed();
    expect(sa.comments).toEqual([]);
    expect(app.hub.size).toBe(0);
  });

  it('closes the streams of a revoked session, and only those', async () => {
    const { app, db, b } = await trio();
    const other = new CookieJar();
    const otherSession = addSession(db, b.userId, other, TEST_ENV.ROOSTER_AUTH_SECRET);
    const mine = await listen(b);
    const res = await app.request('/api/v1/events', {
      headers: { cookie: other.header(), origin: BASE_URL },
    });
    const theirs = new SseClient(res);
    open.push(theirs);
    await until(() => theirs.hello !== undefined);

    await b.ok('DELETE', `/api/v1/me/sessions/${otherSession}`, undefined, 204);
    await theirs.waitClosed();
    await mine.waitFor(1);
    expect(mine.closed).toBe(false);
    expect(mine.keys).toEqual(['me']);
    expect(app.hub.size).toBe(1);
  });

  it('closes the stream on sign-out', async () => {
    const { app, b } = await trio();
    const sb = await listen(b);
    const res = await b.call('POST', '/api/auth/sign-out', {});
    expect(res.status).toBe(200);
    await sb.waitClosed();
    expect(app.hub.size).toBe(0);
  });

  it('closes every stream of a user an admin deactivates', async () => {
    const t = ctx();
    const admin = t.user('admin@example.com');
    const u = t.user('u@example.com');
    const [s1, s2, sAdmin] = [await listen(u), await listen(u), await listen(admin)];
    await admin.ok('PATCH', `/api/v1/admin/users/${u.userId}`, { disabled: true });
    await s1.waitClosed();
    await s2.waitClosed();
    expect(sAdmin.closed).toBe(false);
    expect((await u.call('GET', '/api/v1/events')).status).toBe(401);
  });

  it(`keeps at most ${SSE_MAX_PER_SESSION} streams per session and ${SSE_MAX_PER_USER} per user, closing the oldest`, async () => {
    const t = ctx();
    const u = t.user('u@example.com');
    const v = t.user('v@example.com');
    const other = await listen(v);
    const first: SseClient[] = [];
    for (let i = 0; i < SSE_MAX_PER_SESSION; i += 1) first.push(await listen(u));
    expect(t.app.hub.size).toBe(SSE_MAX_PER_SESSION + 1);

    // One more in the same session (a reload): the oldest of that session goes.
    const fifth = await listen(u);
    await first[0]?.waitClosed();
    expect(first.slice(1).every((s) => !s.closed)).toBe(true);
    expect(fifth.closed).toBe(false);
    expect(t.app.hub.size).toBe(SSE_MAX_PER_SESSION + 1);

    // Other sessions of the same user fill the per-user cap; one more closes the user's
    // oldest stream, wherever it is, and never another user's.
    const streamOf = async (jar: CookieJar) => {
      const res = await t.app.request('/api/v1/events', {
        headers: { cookie: jar.header(), origin: BASE_URL },
      });
      const client = new SseClient(res);
      open.push(client);
      await until(() => client.hello !== undefined);
      return client;
    };
    const jars = [new CookieJar(), new CookieJar(), new CookieJar()];
    for (const jar of jars) addSession(t.db, u.userId, jar, TEST_ENV.ROOSTER_AUTH_SECRET);
    for (const jar of jars.slice(0, 2)) {
      for (let i = 0; i < SSE_MAX_PER_SESSION; i += 1) await streamOf(jar);
    }
    expect(t.app.hub.size).toBe(SSE_MAX_PER_USER + 1);
    const thirteenth = await streamOf(jars[2] as CookieJar);
    await first[1]?.waitClosed();
    expect(thirteenth.closed).toBe(false);
    expect(other.closed).toBe(false);
    expect(t.app.hub.size).toBe(SSE_MAX_PER_USER + 1);
  });

  it('shutdown ends every stream at once and refuses new ones', async () => {
    const { app, a, b } = await trio();
    const [sa, sb] = [await listen(a), await listen(b)];
    expect(app.hub.shutdown()).toBe(2);
    await sa.waitClosed();
    await sb.waitClosed();
    const res = await a.call('GET', '/api/v1/events');
    expect(res.status).toBe(503);
    expect(((await res.json()) as Problem).code).toBe('unavailable');
  });

  it('graceful close does not wait for open streams once the hub is shut down', async () => {
    const { app, a } = await trio();
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const connections = trackConnections(server as Parameters<typeof trackConnections>[0]);
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/events`, {
      headers: { cookie: a.jar.header() },
    });
    const sa = new SseClient(res);
    open.push(sa);
    await until(() => sa.hello !== undefined);

    const start = Date.now();
    app.hub.shutdown();
    expect(await connections.close(10_000)).toBe(true);
    expect(Date.now() - start).toBeLessThan(2_000);
    await sa.waitClosed();
  });
});

describe('compactKeys', () => {
  it('drops keys covered by a shorter prefix', () => {
    expect(compactKeys([['task', '1'], ['task'], ['me']])).toEqual([['task'], ['me']]);
  });

  it('collapses repeated first segments above the limit', () => {
    const keys = [['my-list', 'o'], ...Array.from({ length: 10 }, (_, i) => ['task', String(i)])];
    expect(compactKeys(keys, 5)).toEqual([['my-list', 'o'], ['task']]);
    expect(compactKeys(keys, 64)).toEqual(keys);
  });
});

describe('offline-sync support', () => {
  it('a taken tag name is 409 tag_name_taken with the existing tag’s id', async () => {
    const { a, org } = await trio();
    const first = await a.ok<Tag>('POST', `/api/v1/orgs/${org.id}/tags`, { name: 'Ärende' }, 201);
    const res = await a.call('POST', `/api/v1/orgs/${org.id}/tags`, {
      id: '0199aaaa-0000-7000-8000-0000000000aa',
      name: 'ärende',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'tag_name_taken', existingId: first.id });
    const second = await a.ok<Tag>('POST', `/api/v1/orgs/${org.id}/tags`, { name: 'Other' }, 201);
    const rename = await a.call('PATCH', `/api/v1/tags/${second.id}`, { name: 'ÄRENDE' });
    expect(await rename.json()).toMatchObject({ code: 'tag_name_taken', existingId: first.id });
  });

  it('replays creates with the same client id without an Idempotency-Key', async () => {
    const { app, a, org } = await trio();
    const events: DomainEvent[] = [];
    app.services.events.on((e) => events.push(e));
    const replay = async (path: string, body: unknown) => {
      const first = await a.call('POST', path, body);
      const second = await a.call('POST', path, body);
      expect(second.status).toBe(first.status);
      expect(await second.json()).toEqual(await first.json());
      return first.status;
    };
    const taskId = '0199aaaa-0000-7000-8000-000000000101';
    expect(await replay(`/api/v1/orgs/${org.id}/tasks`, { id: taskId, title: 'T' })).toBe(201);
    expect(
      await replay(`/api/v1/orgs/${org.id}/tasks`, {
        id: '0199aaaa-0000-7000-8000-000000000102',
        title: 'Sub',
        parentId: taskId,
      }),
    ).toBe(201);
    expect(
      await replay(`/api/v1/orgs/${org.id}/groups`, {
        id: '0199aaaa-0000-7000-8000-000000000103',
        name: 'G',
      }),
    ).toBe(201);
    expect(
      await replay(`/api/v1/orgs/${org.id}/tags`, {
        id: '0199aaaa-0000-7000-8000-000000000104',
        name: 'Tag',
      }),
    ).toBe(201);
    expect(
      await replay(`/api/v1/tasks/${taskId}/duplicate`, {
        id: '0199aaaa-0000-7000-8000-000000000105',
      }),
    ).toBe(201);
    // Replays change nothing, so they publish nothing either.
    expect(events.map((e) => e.type)).toEqual([
      'task.created',
      'task.created',
      'group.created',
      'tag.created',
      'task.created',
    ]);
  });

  it('group delete and restore are last-write-wins on the edit time', async () => {
    const { a, org } = await trio();
    const group = await a.ok<{ group: { id: string } }>(
      'POST',
      `/api/v1/orgs/${org.id}/groups`,
      { name: 'G' },
      201,
    );
    const id = group.group.id;
    const now = Date.now();
    await a.ok('DELETE', `/api/v1/groups/${id}`, {}, 204, {
      'X-Rooster-Edit-Time': String(now - 2000),
    });
    await a.ok('POST', `/api/v1/groups/${id}/restore`, undefined, 200, {
      'X-Rooster-Edit-Time': String(now - 1000),
    });
    // A delete made offline before the restore arrives late and loses.
    await a.ok('DELETE', `/api/v1/groups/${id}`, {}, 204, {
      'X-Rooster-Edit-Time': String(now - 1500),
    });
    const list = await a.ok<{ groups: { id: string }[] }>('GET', `/api/v1/orgs/${org.id}/my-list`);
    expect(list.groups.map((g) => g.id)).toContain(id);
  });

  it('an added tag’s chip order follows the edit time', async () => {
    const { a, org } = await trio();
    const task = await createTask(a, { title: 'T' }, org.id);
    const x = await a.ok<Tag>('POST', `/api/v1/orgs/${org.id}/tags`, { name: 'X' }, 201);
    const y = await a.ok<Tag>('POST', `/api/v1/orgs/${org.id}/tags`, { name: 'Y' }, 201);
    const now = Date.now();
    await a.ok('PUT', `/api/v1/tasks/${task.id}/tags/${x.id}`, undefined, 200, {
      'X-Rooster-Edit-Time': String(now),
    });
    const tagged = await a.ok<Task>(
      'PUT',
      `/api/v1/tasks/${task.id}/tags/${y.id}`,
      undefined,
      200,
      {
        'X-Rooster-Edit-Time': String(now - 60_000),
      },
    );
    expect(tagged.tagIds).toEqual([y.id, x.id]);
  });

  it('accepts X-Rooster-Edit-Time on expansion and tag routes alike', async () => {
    const { a, org } = await trio();
    const task = await createTask(a, { title: 'T' }, org.id);
    const headers = { 'X-Rooster-Edit-Time': String(Date.now() + 86_400_000) };
    await a.ok('PUT', `/api/v1/tasks/${task.id}/expanded`, undefined, 204, headers);
    await a.ok('DELETE', `/api/v1/tasks/${task.id}/expanded`, undefined, 204, headers);
    const tag = await a.ok<Tag>('POST', `/api/v1/orgs/${org.id}/tags`, { name: 'T' }, 201, headers);
    await a.ok('PATCH', `/api/v1/tags/${tag.id}`, { name: 'U' }, 200, headers);
  });
});
