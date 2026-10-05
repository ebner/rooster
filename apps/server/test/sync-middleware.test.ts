import type { MyList, Task } from '@rooster/core/schemas';
import { describe, expect, it } from 'vitest';
import { API_RATE_LIMIT, SlidingWindowLimiter } from '../src/lib/rate-limit.ts';
import {
  clampEditTime,
  EDIT_TIME_MAX_FUTURE_MS,
  EDIT_TIME_MAX_PAST_MS,
  parseOpMeta,
} from '../src/lib/request-meta.ts';
import { createTask, inboxOf, listCtx, myList } from './list-helpers.ts';

const key = (n: number) => `019a0000-0000-7000-8000-${String(n).padStart(12, '0')}`;

describe('AC-2.11 idempotency', () => {
  it('a replay returns the same response with no duplicate effect', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const headers = { 'Idempotency-Key': key(1) };
    const first = await a.call('POST', '/api/v1/orgs/personal/tasks', { title: 'Once' }, headers);
    const second = await a.call('POST', '/api/v1/orgs/personal/tasks', { title: 'Once' }, headers);
    expect(second.status).toBe(201);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(second.headers.get('content-type')).toMatch(/application\/json/);
    expect(await second.json()).toEqual(await first.json());
    expect((await myList(a)).tasks).toHaveLength(1);
  });

  it('replays 204s and errors too, and scopes keys per user', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const b = ctx.user('b@example.com');
    const t = await createTask(a, { title: 'x' });
    const del = { 'Idempotency-Key': key(2) };
    expect((await a.call('DELETE', `/api/v1/tasks/${t.id}`, undefined, del)).status).toBe(204);
    await a.ok('POST', `/api/v1/tasks/${t.id}/restore`);
    // The replayed delete does not delete the restored task again.
    const replay = await a.call('DELETE', `/api/v1/tasks/${t.id}`, undefined, del);
    expect(replay.status).toBe(204);
    expect((await myList(a)).tasks).toHaveLength(1);

    const bad = { 'Idempotency-Key': key(3) };
    const e1 = await a.call('POST', '/api/v1/orgs/personal/tasks', { title: '' }, bad);
    const e2 = await a.call('POST', '/api/v1/orgs/personal/tasks', { title: '' }, bad);
    expect([e1.status, e2.status]).toEqual([422, 422]);
    expect(await e2.text()).toBe(await e1.text());

    // The same key from another user is a different operation.
    const other = await b.call(
      'POST',
      '/api/v1/orgs/personal/tasks',
      { title: 'Once' },
      {
        'Idempotency-Key': key(1),
      },
    );
    expect(other.status).toBe(201);
    expect(other.headers.get('idempotent-replayed')).toBeNull();
  });

  it('the same key on a different request is 422 idempotency_key_reuse', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const headers = { 'Idempotency-Key': key(4) };
    await a.ok('POST', '/api/v1/orgs/personal/tasks', { title: 'One' }, 201, headers);
    const body = await a.call('POST', '/api/v1/orgs/personal/tasks', { title: 'Two' }, headers);
    expect(body.status).toBe(422);
    expect(await body.json()).toMatchObject({ code: 'idempotency_key_reuse' });
    const inbox = await inboxOf(a);
    const route = await a.call('PATCH', `/api/v1/groups/${inbox.id}`, { collapsed: true }, headers);
    expect(route.status).toBe(422);
    const malformed = await a.call(
      'POST',
      '/api/v1/orgs/personal/tasks',
      { title: 'x' },
      {
        'Idempotency-Key': 'not a key!',
      },
    );
    expect(malformed.status).toBe(422);
  });

  it('concurrent requests with the same key run once', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const headers = { 'Idempotency-Key': key(5) };
    const responses = await Promise.all(
      [1, 2, 3].map(() =>
        a.call('POST', '/api/v1/orgs/personal/tasks', { title: 'Race' }, headers),
      ),
    );
    const bodies = (await Promise.all(responses.map((r) => r.json()))) as Task[];
    expect(responses.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(new Set(bodies.map((b) => b.id)).size).toBe(1);
    expect((await myList(a)).tasks).toHaveLength(1);
  });

  it('expired keys are not replayed', async () => {
    let now = Date.now();
    const ctx = listCtx({ clock: () => now });
    const a = ctx.user('a@example.com');
    const headers = { 'Idempotency-Key': key(6) };
    await a.ok('POST', '/api/v1/orgs/personal/tasks', { title: 'Old' }, 201, headers);
    now += 8 * 86_400_000;
    await a.ok('POST', '/api/v1/orgs/personal/tasks', { title: 'Old' }, 201, headers);
    expect((await a.ok<MyList>('GET', '/api/v1/orgs/personal/my-list')).tasks).toHaveLength(2);
  });
});

describe('edit time and client headers', () => {
  it('clamps X-Rooster-Edit-Time to [now − 30 d, now + 5 s]; malformed means now', () => {
    const now = 1_800_000_000_000;
    expect(clampEditTime(undefined, now)).toBe(now);
    expect(clampEditTime('soon', now)).toBe(now);
    expect(clampEditTime(String(now - 1000), now)).toBe(now - 1000);
    expect(clampEditTime('0', now)).toBe(now - EDIT_TIME_MAX_PAST_MS);
    expect(clampEditTime(String(now + 60_000), now)).toBe(now + EDIT_TIME_MAX_FUTURE_MS);
  });

  it('captures the client id and client kind when well-formed', () => {
    expect(parseOpMeta({ clientId: 'tab-1', client: 'cli/1.2.0' }, 5)).toEqual({
      editTime: 5,
      clientId: 'tab-1',
      client: 'cli/1.2.0',
    });
    expect(parseOpMeta({ clientId: 'bad id', client: '<script>' }, 5)).toMatchObject({
      clientId: null,
      client: null,
    });
  });
});

describe('per-user API rate limit', () => {
  it('defaults to 600 requests per minute', () => {
    expect(API_RATE_LIMIT).toEqual({ max: 600, windowMs: 60_000 });
    const limiter = new SlidingWindowLimiter(API_RATE_LIMIT);
    for (let i = 0; i < 600; i++) expect(limiter.hit('u', 1000 + i)).toBe(0);
    expect(limiter.hit('u', 2000)).toBe(60_000 - 1000);
    expect(limiter.hit('u', 61_001)).toBe(0);
  });

  it('answers 429 rate_limited with Retry-After, per user, sliding', async () => {
    let now = Date.now();
    const ctx = listCtx({ clock: () => now, apiRateLimit: { max: 3, windowMs: 60_000 } });
    const a = ctx.user('a@example.com');
    const b = ctx.user('b@example.com');
    for (let i = 0; i < 3; i++) {
      expect((await a.call('GET', '/api/v1/orgs/personal/my-list')).status).toBe(200);
      now += 10_000;
    }
    const limited = await a.call('GET', '/api/v1/orgs/personal/my-list');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('30');
    expect(await limited.json()).toMatchObject({ code: 'rate_limited' });
    // Other users and public routes are unaffected.
    expect((await b.call('GET', '/api/v1/orgs/personal/my-list')).status).toBe(200);
    expect((await a.call('GET', '/api/v1/meta')).status).toBe(200);
    now += 30_001;
    expect((await a.call('GET', '/api/v1/orgs/personal/my-list')).status).toBe(200);
  });
});
