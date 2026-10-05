import { listOps, tasksInGroup } from '@rooster/core/reducers';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError } from '../errors';
import { createFixtureTransport } from '../pipeline/fixture-transport';
import { myListKey } from '../pipeline/pipeline';
import type { Me } from '../types';
import { nullChannel, type SyncChannel, type SyncMessage } from './channel';
import { type SyncEngine, startSync } from './engine';
import type { EventSourceLike } from './events';
import { createMemoryOutbox } from './outbox';
import { cacheStorageKey, createCachePersister, type KeyValueStorage } from './persist';

const userId = '01900000-0000-7000-8000-000000000001';
const orgId = '01900000-0000-7000-8000-0000000000aa';

function memoryStorage() {
  const data = new Map<string, string>();
  const storage: KeyValueStorage = {
    get: async (k) => data.get(k),
    set: async (k, v) => void data.set(k, v),
    del: async (k) => void data.delete(k),
  };
  return { data, storage };
}

const quietSource = (): EventSourceLike => ({
  readyState: 0,
  onopen: null,
  onerror: null,
  addEventListener: () => {},
  close: () => {},
});

function me(id: string): Me {
  return {
    user: { id } as Me['user'],
    orgs: [{ id: orgId, slug: 'personal' } as Me['orgs'][number]],
  };
}

const engines: SyncEngine[] = [];

async function boot(
  deps: {
    storage: KeyValueStorage;
    outbox: ReturnType<typeof createMemoryOutbox>;
    transport: ReturnType<typeof createFixtureTransport>;
    channel?: SyncChannel;
  },
  queryClient = new QueryClient(),
) {
  const engine = await startSync({
    queryClient,
    transport: deps.transport,
    outbox: deps.outbox,
    channel: deps.channel ?? nullChannel(),
    persister: createCachePersister((org) => engine.pipeline.baseOf(org), deps.storage),
    eventSource: quietSource,
    locks: null,
    listen: false,
  });
  engines.push(engine);
  return { engine, queryClient };
}

afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop();
  localStorage.clear();
});

describe('sync engine (04 §6)', () => {
  test('a reload restores the cache and replays the outbox before anything is sent', async () => {
    const { data, storage } = memoryStorage();
    const outbox = createMemoryOutbox();
    const transport = createFixtureTransport({ userId, tasks: { 1: ['A'] } });
    const first = await boot({ storage, outbox, transport });
    const state = await first.queryClient.fetchQuery({
      queryKey: myListKey(orgId),
      queryFn: () => first.engine.pipeline.fetch(orgId),
    });
    const today = Object.values(state.groups).find((g) => g.name === 'Today')?.id as string;
    // No fresh /me yet: nothing may be sent, the op waits in the outbox.
    first.engine.pipeline.enqueue(
      orgId,
      [listOps.createTask({ id: 'n1', title: 'Offline', groupId: today })],
      { userId },
    );
    await vi.waitFor(() => expect(outbox.records.size).toBe(1));
    await vi.waitFor(() => expect(data.has(cacheStorageKey)).toBe(true), { timeout: 6000 });
    // The stored my-list is the confirmed base, without the pending op.
    expect(data.get(cacheStorageKey)).not.toContain('Offline');
    first.engine.stop();

    const second = await boot({ storage, outbox, transport });
    const view = second.engine.pipeline.view(orgId);
    expect(view && tasksInGroup(view, today).map((t) => t.title)).toEqual(['A', 'Offline']);
    expect(second.engine.pipeline.pending).toBe(1);
    expect(transport.state(orgId).tasks.n1).toBeUndefined();

    second.queryClient.setQueryData(['me'], me(userId));
    await second.engine.pipeline.idle();
    expect(transport.state(orgId).tasks.n1?.title).toBe('Offline');
    await vi.waitFor(() => expect(outbox.records.size).toBe(0));
  });

  test('another user signing in wipes the previous cache and outbox in every tab', async () => {
    const { storage } = memoryStorage();
    const outbox = createMemoryOutbox();
    const transport = createFixtureTransport({ userId, tasks: { 1: ['A'] } });
    const posted: SyncMessage[] = [];
    const channel: SyncChannel = { ...nullChannel(), post: (m) => posted.push(m) };
    localStorage.setItem('rooster.cacheOwner', 'someone-else');
    const { engine, queryClient } = await boot({ storage, outbox, transport, channel });
    await queryClient.fetchQuery({
      queryKey: myListKey(orgId),
      queryFn: () => engine.pipeline.fetch(orgId),
    });
    await outbox.put([
      {
        op: { ...listOps.deleteTask('x'), opId: 'op-1', editTime: 1, clientId: 'c' },
        orgId,
        ctx: { userId: 'someone-else' },
      },
    ]);
    queryClient.setQueryData(['me'], me(userId));
    await vi.waitFor(() => expect(posted).toContainEqual({ type: 'cleared' }));
    expect(outbox.records.size).toBe(0);
    expect(queryClient.getQueryData(myListKey(orgId))).toBeUndefined();
    expect(queryClient.getQueryData(['me'])).toBeDefined();
    expect(localStorage.getItem('rooster.cacheOwner')).toBe(userId);
  });

  test('an online 401 on /me drops the cached data but keeps the outbox for that user', async () => {
    const { data, storage } = memoryStorage();
    const outbox = createMemoryOutbox();
    const transport = createFixtureTransport({ userId });
    const { engine, queryClient } = await boot({ storage, outbox, transport });
    await queryClient.fetchQuery({
      queryKey: myListKey(orgId),
      queryFn: () => engine.pipeline.fetch(orgId),
    });
    queryClient.setQueryData(['me'], me(userId));
    await outbox.put([
      {
        op: { ...listOps.deleteTask('x'), opId: 'op-1', editTime: 1, clientId: 'c' },
        orgId,
        ctx: { userId },
      },
    ]);
    data.set(cacheStorageKey, '{}');
    await queryClient
      .fetchQuery({
        queryKey: ['me'],
        queryFn: () => Promise.reject(new ApiError('unauthenticated', 401)),
        staleTime: 0,
        retry: false,
      })
      .catch(() => {});
    expect(queryClient.getQueryData(myListKey(orgId))).toBeUndefined();
    await vi.waitFor(() => expect(data.has(cacheStorageKey)).toBe(false));
    expect(outbox.records.size).toBe(1);
    expect(localStorage.getItem('rooster.cacheOwner')).toBe(userId);
  });

  test('sign-out clears everything and tells the other tabs', async () => {
    const { data, storage } = memoryStorage();
    const outbox = createMemoryOutbox();
    const transport = createFixtureTransport({ userId });
    const posted: SyncMessage[] = [];
    const channel: SyncChannel = { ...nullChannel(), post: (m) => posted.push(m) };
    data.set(cacheStorageKey, '{"timestamp":0,"buster":"x","clientState":{"queries":[]}}');
    const { engine } = await boot({ storage, outbox, transport, channel });
    await engine.clear({ final: true });
    expect(data.has(cacheStorageKey)).toBe(false);
    expect(posted).toContainEqual({ type: 'cleared' });
    expect(localStorage.getItem('rooster.cacheOwner')).toBeNull();
  });
});
