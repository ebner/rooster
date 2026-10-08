import { type ListOp, listOps, normalizeMyList, tasksInGroup } from '@rooster/core/reducers';
import type { Tag, Task } from '@rooster/core/schemas';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useSyncStore } from '../../state/sync-store';
import { ApiError } from '../errors';
import { createFixtureTransport } from '../pipeline/fixture-transport';
import { ListPipeline, myListKey } from '../pipeline/pipeline';
import { type ListTransport, RateLimitedError } from '../pipeline/transport';
import type { SyncChannel, SyncMessage } from './channel';
import { createMemoryOutbox, type Outbox } from './outbox';

const userId = '01900000-0000-7000-8000-000000000001';
const orgId = '01900000-0000-7000-8000-0000000000aa';
const ctx = { userId };

/** BroadcastChannel stand-in: delivers asynchronously to every other member. */
function bus() {
  const members = new Set<(m: SyncMessage) => void>();
  const sent: SyncMessage[] = [];
  const channel = (): SyncChannel => {
    let handler: ((m: SyncMessage) => void) | null = null;
    const deliver = (m: SyncMessage) => handler?.(structuredClone(m));
    members.add(deliver);
    return {
      post: (m) => {
        sent.push(m);
        for (const member of members) if (member !== deliver) queueMicrotask(() => member(m));
      },
      listen: (h) => {
        handler = h;
        return () => {
          handler = null;
        };
      },
      close: () => members.delete(deliver),
    };
  };
  return { channel, sent };
}

interface TabOptions {
  transport: ListTransport;
  outbox?: Outbox;
  channel?: SyncChannel;
  leader?: () => boolean;
  online?: () => boolean;
  queryClient?: QueryClient;
  user?: () => string | null;
  afterPaint?: () => Promise<void>;
}

function tab({
  transport,
  outbox,
  channel,
  leader,
  online,
  queryClient,
  user,
  afterPaint,
}: TabOptions) {
  const client = queryClient ?? new QueryClient();
  const pipeline = new ListPipeline({
    transport,
    queryClient: client,
    clientId: 'client-1',
    backoffMs: () => 0,
    ...(outbox ? { outbox } : {}),
    ...(channel ? { channel } : {}),
    ...(leader ? { isLeader: leader } : {}),
    ...(online ? { isOnline: online } : {}),
    ...(user ? { user } : {}),
    ...(afterPaint ? { afterPaint } : {}),
  });
  channel?.listen((m) => pipeline.receive(m));
  return { pipeline, queryClient: client };
}

function spy(inner: ListTransport, fail?: (op: ListOp) => unknown) {
  const sent: string[] = [];
  const transport: ListTransport = {
    ...inner,
    send: async (op, org) => {
      const failure = fail?.(op);
      if (failure) throw failure;
      sent.push(op.kind === 'task.create' ? `create:${op.payload.title}` : op.kind);
      return inner.send(op, org);
    },
  };
  return { transport, sent };
}

async function load(pipeline: ListPipeline, queryClient: QueryClient) {
  queryClient.setQueryData(myListKey(orgId), await pipeline.fetch(orgId));
  const state = pipeline.view(orgId);
  const today = Object.values(state?.groups ?? {}).find((g) => g.name === 'Today');
  if (!today) throw new Error('no Today');
  return today.id;
}

const titles = (pipeline: ListPipeline, groupId: string) =>
  tasksInGroup(pipeline.view(orgId) ?? normalizeMyList(orgId, emptyList()), groupId).map(
    (t) => t.title,
  );

function emptyList() {
  return { groups: [], tasks: [], expandedTaskIds: [], serverTime: 0 };
}

afterEach(() => {
  vi.useRealTimers();
  useSyncStore.setState({ online: true, failures: 0, pending: 0, sessionExpired: false });
});

describe('outbox-backed pipeline (04 §6.2)', () => {
  test('ops are in the outbox before their request leaves', async () => {
    const server = createFixtureTransport({ userId, tasks: { 1: ['A'] } });
    const outbox = createMemoryOutbox();
    const seenInOutbox: boolean[] = [];
    const transport: ListTransport = {
      ...server,
      send: (op, org) => {
        seenInOutbox.push(outbox.records.has(op.opId));
        return server.send(op, org);
      },
    };
    const { pipeline, queryClient } = tab({ transport, outbox });
    const today = await load(pipeline, queryClient);
    pipeline.enqueue(orgId, [listOps.createTask({ id: 'n1', title: 'X', groupId: today })], ctx);
    await pipeline.idle();
    expect(seenInOutbox).toEqual([true]);
    await vi.waitFor(() => expect(outbox.records.size).toBe(0));
  });

  test('a reload replays the outbox on the restored state, then sends it in order', async () => {
    const server = createFixtureTransport({ userId, tasks: { 1: ['A'] } });
    const outbox = createMemoryOutbox();
    let online = false;
    const first = tab({ transport: server, outbox, online: () => online });
    const today = await load(first.pipeline, first.queryClient);
    const base = first.pipeline.baseOf(orgId);
    first.pipeline.enqueue(
      orgId,
      [
        listOps.createTask({ id: 'n1', title: 'One', groupId: today }),
        listOps.createTask({ id: 'n2', title: 'Two', groupId: today, afterId: 'n1' }),
        listOps.patchTask('n1', { title: 'Uno' }),
      ],
      ctx,
    );
    await vi.waitFor(() => expect(outbox.records.size).toBe(3));
    expect(useSyncStore.getState()).toMatchObject({ pending: 3, failures: 0 });

    // Reload: a new page restores the confirmed base and the outbox, still offline.
    const { transport, sent } = spy(server);
    const second = tab({ transport, outbox, online: () => online });
    second.pipeline.restore(new Map([[orgId, base as never]]), await outbox.load());
    expect(titles(second.pipeline, today)).toEqual(['A', 'Uno', 'Two']);
    expect(sent).toEqual([]);

    online = true;
    second.pipeline.retryNow();
    await second.pipeline.idle();
    expect(sent).toEqual(['create:One', 'create:Two', 'task.patch']);
    expect(Object.values(server.state(orgId).tasks).map((t) => t.title)).toEqual(
      expect.arrayContaining(['A', 'Uno', 'Two']),
    );
    await vi.waitFor(() => expect(outbox.records.size).toBe(0));
  });

  test('only the leader sends; followers mirror ops, confirmations and drops', async () => {
    const server = createFixtureTransport({ userId, tasks: { 1: ['A', 'B'] } });
    const { channel } = bus();
    const outbox = createMemoryOutbox();
    const leaderSpy = spy(server);
    const followerSpy = spy(server);
    const leader = tab({
      transport: leaderSpy.transport,
      outbox,
      channel: channel(),
      leader: () => true,
    });
    const follower = tab({
      transport: followerSpy.transport,
      outbox,
      channel: channel(),
      leader: () => false,
    });
    const today = await load(leader.pipeline, leader.queryClient);
    await load(follower.pipeline, follower.queryClient);

    follower.pipeline.enqueue(
      orgId,
      [listOps.createTask({ id: 'f1', title: 'From B', groupId: today })],
      ctx,
    );
    expect(titles(follower.pipeline, today)).toContain('From B');
    await vi.waitFor(() => expect(leaderSpy.sent).toEqual(['create:From B']));
    await vi.waitFor(() => expect(follower.pipeline.pending).toBe(0));
    expect(followerSpy.sent).toEqual([]);
    // The follower folded the leader's confirmation into its own state (server seq).
    expect(follower.pipeline.baseOf(orgId)?.tasks.f1?.seq).not.toBeNull();

    const a = Object.values(server.state(orgId).tasks).find((t) => t.title === 'A') as Task;
    server.failNext(410, 'conflict_deleted');
    const dropped = vi.fn();
    follower.pipeline.onDropped(dropped);
    follower.pipeline.enqueue(orgId, [listOps.patchTask(a.id, { title: 'Gone' })], ctx);
    await vi.waitFor(() => expect(dropped).toHaveBeenCalledOnce());
    expect(dropped.mock.calls[0]?.[0].error).toMatchObject({
      code: 'conflict_deleted',
      status: 410,
    });
    expect(follower.pipeline.view(orgId)?.tasks[a.id]?.title).toBe('A');
    expect(followerSpy.sent).toEqual([]);
  });

  test('a follower asks the leader to retry instead of sending itself', async () => {
    const { channel, sent } = bus();
    const server = createFixtureTransport({ userId });
    const follower = tab({ transport: server, channel: channel(), leader: () => false });
    follower.pipeline.retryNow();
    expect(sent).toEqual([{ type: 'flush' }]);
  });
});

describe('error classes (04 §6.2)', () => {
  test('409 tag_name_taken with existingId remaps the client tag in queued ops and caches', async () => {
    const server = createFixtureTransport({
      userId,
      tasks: { 1: ['A'] },
      tags: [{ name: 'Work' }],
    });
    const outbox = createMemoryOutbox();
    const { channel, sent: messages } = bus();
    const { transport, sent } = spy(server);
    const { pipeline, queryClient } = tab({ transport, outbox, channel: channel() });
    await load(pipeline, queryClient);
    const a = Object.values(server.state(orgId).tasks)[0] as Task;
    const existing = (server.tags(orgId).find((t) => t.name === 'Work') as Tag).id;
    const dropped = vi.fn();
    pipeline.onDropped(dropped);

    // Created offline on this device while another device created "work" first.
    pipeline.enqueue(
      orgId,
      [listOps.createTag({ id: 'client-tag', name: 'work' }), listOps.addTag(a.id, 'client-tag')],
      ctx,
    );
    expect(pipeline.view(orgId)?.tasks[a.id]?.tagIds).toEqual(['client-tag']);
    await pipeline.idle();
    expect(dropped).not.toHaveBeenCalled();
    // The create was refused (409), the tag op went out with the existing id.
    expect(sent).toEqual(['tag.create', 'task.addTag']);
    expect(server.state(orgId).tasks[a.id]?.tagIds).toEqual([existing]);
    expect(pipeline.view(orgId)?.tasks[a.id]?.tagIds).toEqual([existing]);
    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'remap', from: 'client-tag', to: existing }),
    );
    await vi.waitFor(() => expect(outbox.records.size).toBe(0));
  });

  test('without existingId the org tags tell which tag has the name', async () => {
    const server = createFixtureTransport({
      userId,
      tasks: { 1: ['A'] },
      tags: [{ name: 'Home' }],
    });
    const existing = (server.tags(orgId)[0] as Tag).id;
    const { transport, sent } = spy(server, (op) =>
      op.kind === 'tag.create' ? new ApiError('tag_name_taken', 409) : undefined,
    );
    const { pipeline, queryClient } = tab({ transport });
    await load(pipeline, queryClient);
    const a = Object.values(server.state(orgId).tasks)[0] as Task;
    pipeline.enqueue(
      orgId,
      [listOps.createTag({ id: 't-new', name: 'HOME' }), listOps.addTag(a.id, 't-new')],
      ctx,
    );
    await pipeline.idle();
    expect(sent).toEqual(['task.addTag']);
    expect(server.state(orgId).tasks[a.id]?.tagIds).toEqual([existing]);
  });

  test('429 waits for Retry-After without counting as a sync problem', async () => {
    vi.useFakeTimers();
    const server = createFixtureTransport({ userId, tasks: { 1: ['A'] } });
    let limited = true;
    const { transport, sent } = spy(server, () => {
      if (!limited) return undefined;
      limited = false;
      return new RateLimitedError(5_000);
    });
    const { pipeline } = tab({ transport });
    const loaded = pipeline.fetch(orgId);
    await vi.runAllTimersAsync();
    const state = await loaded;
    const a = Object.values(state.tasks)[0] as Task;
    pipeline.enqueue(orgId, [listOps.completeTask(a.id, true)], ctx);
    await vi.advanceTimersByTimeAsync(4_900);
    expect(sent).toEqual([]);
    expect(useSyncStore.getState().failures).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(sent).toEqual(['task.complete']);
  });

  test('network errors while offline wait for the network instead of failing', async () => {
    vi.useFakeTimers();
    const server = createFixtureTransport({ userId, tasks: { 1: ['A'] } });
    let online = false;
    const { transport, sent } = spy(server, () =>
      online ? undefined : new TypeError('Failed to fetch'),
    );
    const { pipeline } = tab({ transport, online: () => online });
    const loaded = pipeline.fetch(orgId);
    await vi.runAllTimersAsync();
    const a = Object.values((await loaded).tasks)[0] as Task;
    pipeline.enqueue(orgId, [listOps.deleteTask(a.id)], ctx);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent).toEqual([]);
    expect(useSyncStore.getState()).toMatchObject({ failures: 0, pending: 1 });
    online = true;
    pipeline.retryNow();
    await vi.advanceTimersByTimeAsync(10);
    expect(sent).toEqual(['task.delete']);
  });

  test('5xx counts failures and reports the last error until a success', async () => {
    vi.useFakeTimers();
    const server = createFixtureTransport({ userId, tasks: { 1: ['A'] } });
    let failures = 3;
    const { transport } = spy(server, () =>
      failures-- > 0 ? new ApiError('http_503', 503) : undefined,
    );
    const pipeline = new ListPipeline({
      transport,
      queryClient: new QueryClient(),
      clientId: 'c',
      backoffMs: () => 1_000,
    });
    const loaded = pipeline.fetch(orgId);
    await vi.runAllTimersAsync();
    const a = Object.values((await loaded).tasks)[0] as Task;
    pipeline.enqueue(orgId, [listOps.deleteTask(a.id)], ctx);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(useSyncStore.getState()).toMatchObject({ failures: 3, lastError: 'http_503' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(useSyncStore.getState()).toMatchObject({ failures: 0, lastError: null, pending: 0 });
  });
});

describe('AC-1.0.1 the outbox is bound to its user', () => {
  test('records carry their user; a different confirmed user never sends them', async () => {
    const server = createFixtureTransport({ userId, tasks: { 1: ['A'] } });
    const { transport, sent } = spy(server);
    const outbox = createMemoryOutbox();
    let online = false;
    let current: string | null = userId;
    const { pipeline, queryClient } = tab({
      transport,
      outbox,
      online: () => online,
      user: () => current,
    });
    const today = await load(pipeline, queryClient);
    pipeline.enqueue(orgId, [listOps.createTask({ id: 'n1', title: 'Mine', groupId: today })], ctx);
    await vi.waitFor(() => expect(outbox.records.size).toBe(1));
    expect([...outbox.records.values()][0]?.userId).toBe(userId);

    // Someone else is confirmed before the op could leave.
    current = 'someone-else';
    online = true;
    pipeline.retryNow();
    await pipeline.idle();
    expect(sent).toEqual([]);
    expect(pipeline.pending).toBe(0);
    expect(titles(pipeline, today)).toEqual(['A']);
    await vi.waitFor(() => expect(outbox.records.size).toBe(0));
  });

  test('a reload as another user neither replays nor keeps the records', async () => {
    const server = createFixtureTransport({ userId, tasks: { 1: ['A'] } });
    const outbox = createMemoryOutbox();
    const first = tab({ transport: server, outbox, online: () => false, user: () => userId });
    const today = await load(first.pipeline, first.queryClient);
    const base = first.pipeline.baseOf(orgId);
    first.pipeline.enqueue(
      orgId,
      [listOps.createTask({ id: 'n1', title: 'Mine', groupId: today })],
      ctx,
    );
    await vi.waitFor(() => expect(outbox.records.size).toBe(1));

    const second = tab({ transport: server, outbox, user: () => 'someone-else' });
    second.pipeline.restore(new Map([[orgId, base as never]]), await outbox.load());
    expect(second.pipeline.pending).toBe(0);
    expect(titles(second.pipeline, today)).toEqual(['A']);
    await vi.waitFor(() => expect(outbox.records.size).toBe(0));
  });

  test('ops mirrored from a tab of another user are ignored', async () => {
    const server = createFixtureTransport({ userId, tasks: { 1: ['A'] } });
    const { pipeline, queryClient } = tab({ transport: server, user: () => userId });
    const today = await load(pipeline, queryClient);
    const op = {
      ...listOps.createTask({ id: 'n1', title: 'Theirs', groupId: today }),
      opId: 'op-1',
      editTime: 1,
      clientId: 'c',
    };
    pipeline.receive({ type: 'enqueued', records: [{ op, orgId, ctx, userId: 'someone-else' }] });
    expect(pipeline.pending).toBe(0);
  });

  test('an op still waiting for its paint is not written back after a reset', async () => {
    const server = createFixtureTransport({ userId, tasks: { 1: ['A'] } });
    const outbox = createMemoryOutbox();
    const { channel: makeChannel, sent: posted } = bus();
    let paint: () => void = () => {};
    const painted = new Promise<void>((resolve) => {
      paint = resolve;
    });
    const { pipeline, queryClient } = tab({
      transport: server,
      outbox,
      channel: makeChannel(),
      online: () => false,
      afterPaint: () => painted,
    });
    const today = await load(pipeline, queryClient);
    pipeline.enqueue(orgId, [listOps.createTask({ id: 'n1', title: 'X', groupId: today })], ctx);
    // Sign-out: the pipeline forgets, the outbox is cleared, and only then the frame paints.
    pipeline.reset();
    await outbox.clear();
    paint();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(outbox.records.size).toBe(0);
    expect(posted.filter((m) => m.type === 'enqueued')).toEqual([]);
  });
});
