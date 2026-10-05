import { type ListOp, listOps, normalizeMyList, tasksInGroup } from '@rooster/core/reducers';
import type { MyList, Task } from '@rooster/core/schemas';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useSyncStore } from '../../state/sync-store';
import { ApiError } from '../errors';
import { createFixtureTransport } from './fixture-transport';
import { ListPipeline, myListKey } from './pipeline';
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
      fetchMyList: transport.fetchMyList,
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
      fetchMyList: transport.fetchMyList,
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
      fetchMyList: transport.fetchMyList,
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

  test('enqueue needs loaded state; seed provides it', () => {
    const { pipeline } = setup(fixture());
    expect(() => pipeline.enqueue(orgId, [listOps.deleteTask('x')], { userId })).toThrow();
    pipeline.seed(orgId, normalizeMyList(orgId, emptyList()));
    expect(pipeline.view(orgId)).toBeDefined();
  });
});
