import { type ListOp, listOps, normalizeMyList, tasksInGroup } from '@rooster/core/reducers';
import type { MyList, Task, TaskDetail } from '@rooster/core/schemas';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useSyncStore } from '../../state/sync-store';
import { ApiError } from '../errors';
import { createFixtureTransport } from './fixture-transport';
import { deepEqual, ListPipeline, myListKey, taskDetailKey } from './pipeline';
import {
  classifyFailure,
  type ListTransport,
  opHeaders,
  parseRetryAfter,
  RateLimitedError,
} from './transport';

const userId = '01900000-0000-7000-8000-000000000001';
const orgId = '01900000-0000-7000-8000-0000000000aa';

function setup(transport: ListTransport, backoffMs = () => 0) {
  const queryClient = new QueryClient();
  const pipeline = new ListPipeline({ transport, queryClient, clientId: 'client-1', backoffMs });
  return { queryClient, pipeline };
}

function fixture() {
  return createFixtureTransport({ userId, tasks: { 1: ['A', 'B'] } });
}

const titles = (pipeline: ListPipeline, groupId: string) =>
  tasksInGroup(pipeline.view(orgId) ?? normalizeMyList(orgId, emptyList()), groupId).map(
    (t) => t.title,
  );

function emptyList(): MyList {
  return { groups: [], tasks: [], expandedTaskIds: [], serverTime: 0 };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('transport helpers', () => {
  test('ops carry the idempotency, edit-time and client headers (04 §6.2)', () => {
    const op = { ...listOps.deleteTask('t'), opId: 'op-1', editTime: 42, clientId: 'c' } as ListOp;
    expect(opHeaders(op)).toEqual({
      'Idempotency-Key': 'op-1',
      'X-Rooster-Edit-Time': '42',
      'X-Rooster-Client-Id': 'c',
    });
  });

  test('classifies failures: drop, auth, rate, transient', () => {
    for (const status of [400, 403, 404, 409, 410, 422]) {
      expect(classifyFailure(new ApiError('x', status))).toBe('drop');
    }
    expect(classifyFailure(new ApiError('x', 401))).toBe('auth');
    expect(classifyFailure(new RateLimitedError(1000))).toBe('rate');
    expect(classifyFailure(new ApiError('x', 503))).toBe('transient');
    expect(classifyFailure(new ApiError('x', 408))).toBe('transient');
    expect(classifyFailure(new TypeError('Failed to fetch'))).toBe('transient');
  });

  test('parses Retry-After seconds and dates', () => {
    expect(parseRetryAfter('3', 0)).toBe(3000);
    expect(parseRetryAfter(null, 0)).toBe(5000);
    expect(parseRetryAfter('garbage', 0)).toBe(5000);
    const now = Date.parse('2026-10-05T10:00:00Z');
    expect(parseRetryAfter('Mon, 05 Oct 2026 10:00:10 GMT', now)).toBe(10_000);
  });
});

describe('ListPipeline', () => {
  test('applies ops to the cache synchronously, then sends them in order', async () => {
    const transport = fixture();
    const sent: string[] = [];
    const spy: ListTransport = {
      ...transport,
      fetchTask: () => Promise.reject(new Error('unused')),
      fetchTags: async () => [],
      send: (op, org) => {
        sent.push(op.kind);
        return transport.send(op, org);
      },
    };
    const { pipeline, queryClient } = setup(spy);
    await pipeline.fetch(orgId).then((s) => queryClient.setQueryData(myListKey(orgId), s));
    const today = Object.values(pipeline.view(orgId)?.groups ?? {}).find((g) => g.name === 'Today');
    if (!today) throw new Error('no Today');
    const [a] = tasksInGroup(pipeline.view(orgId) as never, today.id);

    pipeline.enqueue(
      orgId,
      [
        listOps.createTask({ id: 'n1', title: 'New', groupId: today.id, afterId: a?.id ?? null }),
        listOps.patchTask('n1', { title: 'Renamed' }),
      ],
      { userId },
    );
    // Optimistic and synchronous: before any network round trip.
    expect(titles(pipeline, today.id)).toEqual(['A', 'Renamed', 'B']);
    expect(useSyncStore.getState().pending).toBe(2);
    await pipeline.idle();
    expect(sent).toEqual(['task.create', 'task.patch']);
    // The server's DTO (with seq) replaced the optimistic one; the newer patch was not lost.
    expect(pipeline.view(orgId)?.tasks.n1).toMatchObject({ title: 'Renamed', seq: 3 });
    expect(useSyncStore.getState().pending).toBe(0);
  });

  test('a refetch while ops are pending keeps the optimistic changes on top', async () => {
    const transport = fixture();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: ListTransport = {
      ...transport,
      fetchTask: () => Promise.reject(new Error('unused')),
      fetchTags: async () => [],
      send: async (op, org) => {
        await gate;
        return transport.send(op, org);
      },
    };
    const { pipeline, queryClient } = setup(slow);
    queryClient.setQueryData(myListKey(orgId), await pipeline.fetch(orgId));
    const today = Object.values(pipeline.view(orgId)?.groups ?? {}).find((g) => g.name === 'Today');
    pipeline.enqueue(
      orgId,
      [listOps.createTask({ id: 'n1', title: 'Pending', groupId: today?.id as string })],
      { userId },
    );
    queryClient.setQueryData(myListKey(orgId), await pipeline.fetch(orgId));
    expect(titles(pipeline, today?.id as string)).toEqual(['A', 'B', 'Pending']);
    release();
    await pipeline.idle();
    expect(titles(pipeline, today?.id as string)).toEqual(['A', 'B', 'Pending']);
  });

  test('drop-class errors revert the op and notify listeners (02 §14)', async () => {
    const transport = fixture();
    const { pipeline, queryClient } = setup(transport);
    queryClient.setQueryData(myListKey(orgId), await pipeline.fetch(orgId));
    const before = pipeline.view(orgId);
    const task = Object.values(before?.tasks ?? {})[0] as Task;
    const dropped = vi.fn();
    pipeline.onDropped(dropped);
    transport.failNext(410, 'conflict_deleted');
    pipeline.enqueue(orgId, [listOps.patchTask(task.id, { title: 'Lost' })], { userId });
    expect(pipeline.view(orgId)?.tasks[task.id]?.title).toBe('Lost');
    await pipeline.idle();
    expect(pipeline.view(orgId)?.tasks[task.id]?.title).toBe(task.title);
    expect(dropped).toHaveBeenCalledOnce();
    expect(dropped.mock.calls[0]?.[0]).toMatchObject({ error: { code: 'conflict_deleted' } });
    expect(dropped.mock.calls[0]?.[0].before.tasks[task.id].title).toBe('Lost');
  });

  test('5xx and network errors retry with backoff until they succeed', async () => {
    const transport = fixture();
    const backoff = vi.fn(() => 0);
    const { pipeline, queryClient } = setup(transport, backoff);
    queryClient.setQueryData(myListKey(orgId), await pipeline.fetch(orgId));
    const task = Object.values(pipeline.view(orgId)?.tasks ?? {})[0] as Task;
    transport.failNext(503);
    pipeline.enqueue(orgId, [listOps.completeTask(task.id, true)], { userId });
    await pipeline.idle();
    expect(backoff).toHaveBeenCalledWith(1);
    expect(transport.state(orgId).tasks[task.id]?.completedAt).not.toBeNull();
  });

  test('429 waits for Retry-After; 401 pauses until retryNow', async () => {
    vi.useFakeTimers();
    const transport = fixture();
    const failures: unknown[] = [new RateLimitedError(2000), new ApiError('unauthenticated', 401)];
    const flaky: ListTransport = {
      ...transport,
      fetchTask: () => Promise.reject(new Error('unused')),
      fetchTags: async () => [],
      send: async (op, org) => {
        const failure = failures.shift();
        if (failure) throw failure;
        return transport.send(op, org);
      },
    };
    const { pipeline, queryClient } = setup(flaky);
    const loaded = pipeline.fetch(orgId);
    await vi.runAllTimersAsync();
    queryClient.setQueryData(myListKey(orgId), await loaded);
    const task = Object.values(pipeline.view(orgId)?.tasks ?? {})[0] as Task;
    pipeline.enqueue(orgId, [listOps.deleteTask(task.id)], { userId });
    await vi.advanceTimersByTimeAsync(1999);
    expect(pipeline.pending).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    // The retry hit 401: paused, op kept.
    expect(useSyncStore.getState().sessionExpired).toBe(true);
    expect(pipeline.pending).toBe(1);
    pipeline.retryNow();
    await vi.runAllTimersAsync();
    await pipeline.idle();
    expect(pipeline.pending).toBe(0);
    expect(useSyncStore.getState().sessionExpired).toBe(false);
    expect(transport.state(orgId).tasks[task.id]).toBeUndefined();
  });

  test('ops queue before the list loaded; its first fetch replays them', async () => {
    const transport = fixture();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: ListTransport = {
      ...transport,
      send: async (op, org) => {
        await gate;
        return transport.send(op, org);
      },
    };
    const { pipeline } = setup(slow);
    pipeline.enqueue(orgId, [listOps.createTask({ id: 'n1', title: 'Early' })], { userId });
    expect(pipeline.view(orgId)).toBeUndefined();
    expect(pipeline.pending).toBe(1);
    const state = await pipeline.fetch(orgId);
    expect(state.tasks.n1?.title).toBe('Early');
    release();
    await pipeline.idle();
    pipeline.seed(orgId, normalizeMyList(orgId, emptyList()));
    expect(pipeline.view(orgId)).toBeDefined();
  });
});

describe('ListPipeline, P3 caches', () => {
  test('pending ops are exposed, and confirmed ops move into cached task details', async () => {
    const transport = fixture();
    const { queryClient, pipeline } = setup(transport);
    const state = await pipeline.fetch(orgId);
    const a = Object.values(state.tasks).find((t) => t.title === 'A') as Task;
    queryClient.setQueryData(taskDetailKey(a.id), await transport.fetchTask(a.id));
    const seen: number[] = [];
    const unsubscribe = pipeline.subscribe(() => seen.push(pipeline.getVersion()));
    pipeline.enqueue(orgId, [listOps.patchTask(a.id, { description: '# Notes' })], { userId });
    expect(pipeline.pendingOps(orgId).map((op) => op.kind)).toEqual(['task.patch']);
    await pipeline.idle();
    expect(pipeline.pendingOps(orgId)).toEqual([]);
    expect(queryClient.getQueryData<TaskDetail>(taskDetailKey(a.id))?.description).toBe('# Notes');
    expect(seen.length).toBeGreaterThanOrEqual(2);
    unsubscribe();
  });

  test('a rejected re-parent is dropped, reverted and reported', async () => {
    const transport = createFixtureTransport({
      userId,
      tasks: { 1: [{ title: 'P', subtasks: ['C'] }] },
    });
    const { pipeline } = setup(transport);
    const tasks = Object.values((await pipeline.fetch(orgId)).tasks);
    const p = tasks.find((t) => t.title === 'P') as Task;
    const c = tasks.find((t) => t.title === 'C') as Task;
    const dropped: string[] = [];
    pipeline.onDropped(({ error }) => dropped.push(error.code));
    pipeline.enqueue(orgId, [listOps.patchTask(p.id, { parentId: c.id })], { userId });
    await pipeline.idle();
    expect(dropped).toEqual(['subtask_cycle']);
    expect(pipeline.view(orgId)?.tasks[p.id]?.parentId).toBeNull();
  });
});

test('deepEqual ignores key order and undefined members', () => {
  expect(deepEqual({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1, d: undefined })).toBe(
    true,
  );
  expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
  expect(deepEqual([1], { 0: 1 })).toBe(false);
  expect(deepEqual(null, {})).toBe(false);
});

describe('a closed pipeline (ADR 0051)', () => {
  test('refuses every later op: nothing applied, stored, announced or sent', async () => {
    const transport = fixture();
    const send = vi.spyOn(transport, 'send');
    const { createMemoryOutbox } = await import('../sync/outbox');
    const outbox = createMemoryOutbox();
    const posted: unknown[] = [];
    const pipeline = new ListPipeline({
      transport,
      queryClient: new QueryClient(),
      clientId: 'client-1',
      outbox,
      channel: { post: (m) => posted.push(m), listen: () => () => {}, close: () => {} },
    });
    await pipeline.fetch(orgId);
    pipeline.close();
    expect(pipeline.enqueue(orgId, [listOps.deleteTask('x')], { userId })).toEqual([]);
    await new Promise((r) => setTimeout(r, 10));
    expect(pipeline.pending).toBe(0);
    expect(outbox.records.size).toBe(0);
    expect(posted).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('the send gate after the write-ahead (ADR 0056)', () => {
  test('a session that ends while the outbox write runs sends nothing', async () => {
    const transport = fixture();
    const send = vi.spyOn(transport, 'send');
    const { createMemoryOutbox } = await import('../sync/outbox');
    const memory = createMemoryOutbox();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const outbox = {
      ...memory,
      put: async (records: Parameters<typeof memory.put>[0]) => {
        await held;
        return memory.put(records);
      },
    };
    let allowed = true;
    const pipeline = new ListPipeline({
      transport,
      queryClient: new QueryClient(),
      clientId: 'client-1',
      outbox,
      canSend: () => allowed,
    });
    await pipeline.fetch(orgId);
    pipeline.enqueue(orgId, [listOps.deleteTask('x')], { userId });
    await new Promise((r) => setTimeout(r, 10));
    // The session ends while the op is still being written.
    allowed = false;
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(send).not.toHaveBeenCalled();
    expect(pipeline.pending).toBe(1);
    expect(memory.records.size).toBe(1);
  });
});
