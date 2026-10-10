import { type ListState, listOps, tasksInGroup } from '@rooster/core/reducers';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useSyncStore } from '../../state/sync-store';
import { ApiError } from '../errors';
import { createFixtureTransport } from '../pipeline/fixture-transport';
import { myListKey } from '../pipeline/pipeline';
import type { ListTransport } from '../pipeline/transport';
import { onSessionDataCleared, reopenSessionForTests } from '../session-events';
import type { Me } from '../types';
import { nullChannel, type SyncChannel, type SyncMessage } from './channel';
import { clearLocalData, type SyncEngine, startSync } from './engine';
import type { EventSourceLike } from './events';
import { fakeLocks } from './fake-locks';
import { electLeader } from './leader';
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

const otherOrgId = '01900000-0000-7000-8000-0000000000bb';

function me(id: string, orgIds: readonly string[] = [orgId]): Me {
  return {
    user: { id } as Me['user'],
    orgs: orgIds.map((org) => ({ id: org, slug: org }) as Me['orgs'][number]),
  };
}

/** A `/me` answered by the server (not an optimistic `setQueryData`). */
function fetchMe(queryClient: QueryClient, value: Me) {
  return queryClient.fetchQuery({ queryKey: ['me'], queryFn: async () => value, staleTime: 0 });
}

const recentsKey = (id: string) => `rooster.user.${id}.palette.recent`;

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
  const persister = createCachePersister((org) => engine.pipeline.baseOf(org), deps.storage);
  const engine = await startSync({
    queryClient,
    transport: deps.transport,
    outbox: deps.outbox,
    channel: deps.channel ?? nullChannel(),
    persister,
    eventSource: quietSource,
    locks: null,
    listen: false,
  });
  engines.push(engine);
  return { engine, queryClient, persister };
}

afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop();
  localStorage.clear();
  sessionStorage.clear();
  reopenSessionForTests();
});

describe('sync engine (04 §6)', () => {
  test('a reload restores the cache and replays the outbox before anything is sent', async () => {
    const { data, storage } = memoryStorage();
    const outbox = createMemoryOutbox();
    const transport = createFixtureTransport({ userId, tasks: { 1: ['A'] } });
    const first = await boot({ storage, outbox, transport });
    // As a `/me` of an earlier session did: the cache and the outbox belong to this user, and
    // only a confirmed cache is restored.
    localStorage.setItem('rooster.cacheOwner', userId);
    first.persister.confirmed(Date.now());
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
    const cleared = vi.fn();
    const stop = onSessionDataCleared(cleared);
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
    // State outside the cache (pending uploads) goes too.
    expect(cleared).toHaveBeenCalled();
    stop();
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
    const cleared = vi.fn();
    const stop = onSessionDataCleared(cleared);
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
    expect(cleared).toHaveBeenCalled();
    stop();
  });

  test('answers that arrive after an online 401 on /me do not bring the list back', async () => {
    const outbox = createMemoryOutbox();
    const transport = createFixtureTransport({ userId, tasks: { 1: ['A'] } });
    const { engine, queryClient } = await boot({
      storage: memoryStorage().storage,
      outbox,
      transport,
    });
    await fetchMe(queryClient, me(userId));
    const state = await queryClient.fetchQuery({
      queryKey: myListKey(orgId),
      queryFn: () => engine.pipeline.fetch(orgId),
    });
    const today = Object.values(state.groups).find((g) => g.name === 'Today')?.id as string;
    // The first op's request is out; its answer comes after the session ended.
    const send = transport.send;
    let answer: () => void = () => {};
    const sent = vi.fn();
    transport.send = (op, org, signal) => {
      sent();
      return new Promise((resolve, reject) => {
        answer = () => void send(op, org, signal).then(resolve, reject);
      });
    };
    // So is a list read.
    const fetchMyList = transport.fetchMyList;
    let answerRead: () => void = () => {};
    transport.fetchMyList = (org) =>
      new Promise((resolve, reject) => {
        answerRead = () => void fetchMyList(org).then(resolve, reject);
      });
    engine.pipeline.enqueue(
      orgId,
      [listOps.createTask({ id: 'n1', title: 'Sent', groupId: today })],
      { userId },
    );
    await vi.waitFor(() => expect(sent).toHaveBeenCalled());
    const read = engine.pipeline.fetch(orgId);
    await queryClient
      .fetchQuery({
        queryKey: ['me'],
        queryFn: () => Promise.reject(new ApiError('unauthenticated', 401)),
        staleTime: 0,
        retry: false,
      })
      .catch(() => {});
    expect(queryClient.getQueryData(myListKey(orgId))).toBeUndefined();
    // Queued meanwhile (an editor flushing on unmount): it stays for this user's next sign-in.
    engine.pipeline.enqueue(
      orgId,
      [listOps.createTask({ id: 'n2', title: 'Later', groupId: today })],
      { userId },
    );
    answer();
    answerRead();
    await expect(read).rejects.toBeInstanceOf(ApiError);
    await vi.waitFor(() => expect(transport.state(orgId).tasks.n1?.title).toBe('Sent'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(queryClient.getQueryData(myListKey(orgId))).toBeUndefined();
    expect(engine.pipeline.baseOf(orgId)).toBeUndefined();
    expect(engine.pipeline.pending).toBe(1);
    await vi.waitFor(() => expect([...outbox.records.keys()].length).toBe(1));
    expect([...outbox.records.values()][0]?.op.entityId).toBe('n2');
    expect(transport.state(orgId).tasks.n2).toBeUndefined();
  });

  test('sign-out clears everything and tells the other tabs', async () => {
    const { data, storage } = memoryStorage();
    const outbox = createMemoryOutbox();
    const transport = createFixtureTransport({ userId });
    const posted: SyncMessage[] = [];
    const channel: SyncChannel = { ...nullChannel(), post: (m) => posted.push(m) };
    data.set(cacheStorageKey, '{"timestamp":0,"buster":"x","clientState":{"queries":[]}}');
    const { engine } = await boot({ storage, outbox, transport, channel });
    const cleared = vi.fn();
    const stop = onSessionDataCleared(cleared);
    await engine.clear({ final: true });
    stop();
    expect(cleared).toHaveBeenCalled();
    expect(data.has(cacheStorageKey)).toBe(false);
    expect(posted).toContainEqual({ type: 'cleared' });
    expect(localStorage.getItem('rooster.cacheOwner')).toBeNull();
  });

  test('an edit flushed while sign-out wipes is refused, not left in the outbox', async () => {
    const outbox = createMemoryOutbox();
    const transport = createFixtureTransport({ userId, tasks: { 1: ['A'] } });
    const { engine, queryClient } = await boot({
      storage: memoryStorage().storage,
      outbox,
      transport,
    });
    await fetchMe(queryClient, me(userId));
    await queryClient.fetchQuery({
      queryKey: myListKey(orgId),
      queryFn: () => engine.pipeline.fetch(orgId),
    });
    const taskId = Object.keys(transport.state(orgId).tasks)[0] as string;
    const sent = vi.fn();
    transport.send = async () => sent();
    const clear = outbox.clear.bind(outbox);
    outbox.clear = async () => {
      await clear();
      // The description editor unmounts while the wipe is under way and flushes its edit.
      engine.pipeline.enqueue(
        orgId,
        [listOps.patchTask(taskId, { description: 'Private notes' })],
        { userId },
      );
    };
    await clearLocalData();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(outbox.records.size).toBe(0);
    expect(engine.pipeline.pending).toBe(0);
    expect(sent).not.toHaveBeenCalled();
  });

  test('a document that ran as one account stops everything and reloads when /me is another', async () => {
    const { storage } = memoryStorage();
    const transport = createFixtureTransport({ userId });
    const reload = vi.fn();
    vi.stubGlobal('location', { ...globalThis.location, reload });
    const { useUndoStore } = await import('../../state/undo-store');
    const { readDraft, writeDraft } = await import('../../features/collab/drafts');
    try {
      const { engine, queryClient } = await boot({
        storage,
        outbox: createMemoryOutbox(),
        transport,
      });
      await fetchMe(queryClient, me(userId));
      useUndoStore.getState().push({ orgId, label: 'x', inverseOps: [], redoOps: [] });
      writeDraft('task-1', 'Unsent');
      const cleared = vi.fn();
      const stop = onSessionDataCleared(cleared);
      // Signed in as someone else in another tab: that tab already took over the browser.
      const other = '01900000-0000-7000-8000-000000000002';
      localStorage.setItem('rooster.cacheOwner', other);
      await fetchMe(queryClient, me(other));
      stop();
      expect(cleared).toHaveBeenCalled();
      expect(engine.pipeline.pending).toBe(0);
      expect(useUndoStore.getState().undo).toEqual([]);
      expect(readDraft('task-1')).toBe('');
      await vi.waitFor(() => expect(reload).toHaveBeenCalled());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('after an account change the page sends nothing more, through any client', async () => {
    const { storage } = memoryStorage();
    const reload = vi.fn();
    vi.stubGlobal('location', { ...globalThis.location, reload });
    try {
      const { queryClient } = await boot({
        storage,
        outbox: createMemoryOutbox(),
        transport: createFixtureTransport({ userId }),
      });
      await fetchMe(queryClient, me(userId));
      const other = '01900000-0000-7000-8000-000000000002';
      localStorage.setItem('rooster.cacheOwner', other);
      await fetchMe(queryClient, me(other));
      const { api } = await import('../http');
      await expect(api.GET('/api/v1/me')).rejects.toMatchObject({ code: 'session_closed' });
      const { sendMultipart } = await import('../attachments');
      await expect(
        sendMultipart('PUT', '/api/v1/me/avatar', new Blob(['x']), 'a.png').promise,
      ).rejects.toMatchObject({ code: 'session_closed' });
      await vi.waitFor(() => expect(reload).toHaveBeenCalled());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('a page that rendered a restored account reloads when the first fresh /me is another', async () => {
    const { storage } = memoryStorage();
    const reload = vi.fn();
    vi.stubGlobal('location', { ...globalThis.location, reload });
    try {
      const queryClient = new QueryClient();
      // Restored from storage: confirmed long ago.
      queryClient.setQueryData(['me'], me(userId), { updatedAt: 1 });
      localStorage.setItem('rooster.cacheOwner', userId);
      await boot(
        { storage, outbox: createMemoryOutbox(), transport: createFixtureTransport({ userId }) },
        queryClient,
      );
      const other = '01900000-0000-7000-8000-000000000002';
      await fetchMe(queryClient, me(other));
      await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      // The previous account's browser data went first, and the owner is the new account.
      expect(localStorage.getItem('rooster.cacheOwner')).toBe(other);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('the push subscription is gone before the owner changes and the page reloads', async () => {
    const { storage } = memoryStorage();
    const reload = vi.fn();
    let finishUnsubscribe: (value: boolean) => void = () => {};
    const unsubscribe = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishUnsubscribe = resolve;
        }),
    );
    const registration = { pushManager: { getSubscription: async () => ({ unsubscribe }) } };
    vi.stubGlobal('location', { ...globalThis.location, reload });
    vi.stubGlobal('navigator', {
      ...globalThis.navigator,
      serviceWorker: { getRegistration: async () => registration },
    });
    try {
      const queryClient = new QueryClient();
      // Restored from storage: confirmed long ago.
      queryClient.setQueryData(['me'], me(userId), { updatedAt: 1 });
      localStorage.setItem('rooster.cacheOwner', userId);
      await boot(
        { storage, outbox: createMemoryOutbox(), transport: createFixtureTransport({ userId }) },
        queryClient,
      );
      const other = '01900000-0000-7000-8000-000000000002';
      await fetchMe(queryClient, me(other));
      await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalled());
      expect(localStorage.getItem('rooster.cacheOwner')).toBe(userId);
      expect(reload).not.toHaveBeenCalled();
      finishUnsubscribe(true);
      await vi.waitFor(() => expect(reload).toHaveBeenCalled());
      expect(localStorage.getItem('rooster.cacheOwner')).toBe(other);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('a tab reloads at most once for the same account (no loop when storage cannot be cleared)', async () => {
    const { storage } = memoryStorage();
    const reload = vi.fn();
    vi.stubGlobal('location', { ...globalThis.location, reload });
    try {
      const other = '01900000-0000-7000-8000-000000000002';
      sessionStorage.setItem('rooster.reloadedAs', other);
      const queryClient = new QueryClient();
      // Restored from storage: confirmed long ago.
      queryClient.setQueryData(['me'], me(userId), { updatedAt: 1 });
      await boot(
        { storage, outbox: createMemoryOutbox(), transport: createFixtureTransport({ userId }) },
        queryClient,
      );
      await fetchMe(queryClient, me(other));
      await new Promise((r) => setTimeout(r, 20));
      expect(reload).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("taking over keeps the new account's ops in the shared outbox", async () => {
    const { storage } = memoryStorage();
    const outbox = createMemoryOutbox();
    const reload = vi.fn();
    vi.stubGlobal('location', { ...globalThis.location, reload });
    try {
      const other = '01900000-0000-7000-8000-000000000002';
      const queryClient = new QueryClient();
      // Restored from storage: confirmed long ago.
      queryClient.setQueryData(['me'], me(userId), { updatedAt: 1 });
      localStorage.setItem('rooster.cacheOwner', userId);
      await boot({ storage, outbox, transport: createFixtureTransport({ userId }) }, queryClient);
      const record = (id: string, owner: string) => ({
        op: { ...listOps.deleteTask('x'), opId: id, editTime: 1, clientId: 'c' },
        orgId,
        ctx: { userId: owner },
        userId: owner,
      });
      await outbox.put([record('old', userId), record('new', other)]);
      await fetchMe(queryClient, me(other));
      await vi.waitFor(() => expect(reload).toHaveBeenCalled());
      expect([...outbox.records.keys()]).toEqual(['new']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('a slower tab of the old account does not wipe once another tab took over', async () => {
    const { storage } = memoryStorage();
    const outbox = createMemoryOutbox();
    const reload = vi.fn();
    let finishUnsubscribe: (value: boolean) => void = () => {};
    const unsubscribe = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishUnsubscribe = resolve;
        }),
    );
    const registration = {
      pushManager: {
        getSubscription: async () => ({
          unsubscribe,
        }),
      },
    };
    vi.stubGlobal('location', { ...globalThis.location, reload });
    vi.stubGlobal('navigator', {
      ...globalThis.navigator,
      serviceWorker: { getRegistration: async () => registration },
    });
    try {
      const other = '01900000-0000-7000-8000-000000000002';
      const queryClient = new QueryClient();
      // Restored from storage: confirmed long ago.
      queryClient.setQueryData(['me'], me(userId), { updatedAt: 1 });
      localStorage.setItem('rooster.cacheOwner', userId);
      await boot({ storage, outbox, transport: createFixtureTransport({ userId }) }, queryClient);
      await outbox.put([
        {
          op: { ...listOps.deleteTask('x'), opId: 'old', editTime: 1, clientId: 'c' },
          orgId,
          ctx: { userId },
          userId,
        },
      ]);
      await fetchMe(queryClient, me(other));
      await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalled());
      // Meanwhile the other tab finished first and took the browser over.
      localStorage.setItem('rooster.cacheOwner', other);
      finishUnsubscribe(true);
      await vi.waitFor(() => expect(reload).toHaveBeenCalled());
      expect([...outbox.records.keys()]).toEqual(['old']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('after its one reload, a page still holding the old account drops it in place', async () => {
    const { data, storage } = memoryStorage();
    const reload = vi.fn();
    vi.stubGlobal('location', { ...globalThis.location, reload });
    try {
      const other = '01900000-0000-7000-8000-000000000002';
      sessionStorage.setItem('rooster.reloadedAs', other);
      localStorage.setItem('rooster.cacheOwner', other);
      data.set(cacheStorageKey, '{}');
      const queryClient = new QueryClient();
      // Restored from storage: confirmed long ago.
      queryClient.setQueryData(['me'], me(userId), { updatedAt: 1 });
      queryClient.setQueryData(['notifications', 'x'], { secret: true });
      const outbox = createMemoryOutbox();
      await outbox.put([
        {
          op: { ...listOps.deleteTask('x'), opId: 'mine', editTime: 1, clientId: 'c' },
          orgId,
          ctx: { userId: other },
          userId: other,
        },
      ]);
      const transport = createFixtureTransport({ userId: other });
      const send = vi.spyOn(transport, 'send');
      await boot({ storage, outbox, transport }, queryClient);
      await fetchMe(queryClient, me(other));
      await vi.waitFor(() => expect(data.has(cacheStorageKey)).toBe(false));
      // The new account's queued op stays, goes back into the queue and is sent.
      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({ opId: 'mine' }),
          orgId,
          expect.anything(),
        ),
      );
      expect(queryClient.getQueryData(['notifications', 'x'])).toBeUndefined();
      expect(reload).not.toHaveBeenCalled();
      // The guard is spent: the next switch closes the session again.
      expect(sessionStorage.getItem('rooster.reloadedAs')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('sign-in and sign-out requests are refused once the session is closed', async () => {
    const { closeSessionForGood } = await import('../session-events');
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const { authClient } = await import('../auth-client');
      closeSessionForGood();
      await authClient.signOut({ disableRedirect: true }).catch(() => {});
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("a clear in another tab stops this tab's uploads before anything else is awaited", async () => {
    const { storage } = memoryStorage();
    let handler: ((m: SyncMessage) => void) | null = null;
    const channel: SyncChannel = {
      ...nullChannel(),
      listen: (h) => {
        handler = h;
        return () => {
          handler = null;
        };
      },
    };
    const reload = vi.fn();
    vi.stubGlobal('location', { ...globalThis.location, reload });
    try {
      await boot({
        storage,
        outbox: createMemoryOutbox(),
        transport: createFixtureTransport({ userId }),
        channel,
      });
      const cleared = vi.fn();
      const stop = onSessionDataCleared(cleared);
      (handler as ((m: SyncMessage) => void) | null)?.({ type: 'cleared' });
      // Synchronously: the persister's awaited write comes after.
      expect(cleared).toHaveBeenCalled();
      stop();
      await vi.waitFor(() => expect(reload).toHaveBeenCalled());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('AC-1.0.1 sign-out sweeps per-user localStorage (palette recents)', async () => {
    const { storage } = memoryStorage();
    const transport = createFixtureTransport({ userId });
    const { engine } = await boot({ storage, outbox: createMemoryOutbox(), transport });
    localStorage.setItem(recentsKey(userId), '[{"title":"Secret"}]');
    localStorage.setItem('rooster.palette.recent.old', '[{"title":"Old secret"}]');
    localStorage.setItem('rooster.locale', 'sv');
    await clearLocalData();
    expect(engine.pipeline.pending).toBe(0);
    expect(Object.keys(localStorage)).toEqual(['rooster.locale']);
  });

  test('AC-1.0.1 an online 401 on /me sweeps per-user localStorage', async () => {
    const { storage } = memoryStorage();
    const transport = createFixtureTransport({ userId });
    const { queryClient } = await boot({ storage, outbox: createMemoryOutbox(), transport });
    await fetchMe(queryClient, me(userId));
    localStorage.setItem(recentsKey(userId), '[{"title":"Secret"}]');
    await queryClient
      .fetchQuery({
        queryKey: ['me'],
        queryFn: () => Promise.reject(new ApiError('unauthenticated', 401)),
        staleTime: 0,
        retry: false,
      })
      .catch(() => {});
    expect(localStorage.getItem(recentsKey(userId))).toBeNull();
  });

  test('AC-1.0.1 another user signing in sweeps the previous user’s localStorage', async () => {
    const { storage } = memoryStorage();
    const transport = createFixtureTransport({ userId });
    localStorage.setItem('rooster.cacheOwner', 'someone-else');
    localStorage.setItem(recentsKey('someone-else'), '[{"title":"Secret"}]');
    localStorage.setItem(recentsKey(userId), '[]');
    const { queryClient } = await boot({ storage, outbox: createMemoryOutbox(), transport });
    await fetchMe(queryClient, me(userId));
    expect(localStorage.getItem(recentsKey('someone-else'))).toBeNull();
    expect(localStorage.getItem(recentsKey(userId))).toBe('[]');
  });

  test('AC-1.0.1 a fresh /me without an org drops everything cached for that org', async () => {
    const { data, storage } = memoryStorage();
    const transport = createFixtureTransport({ userId, tasks: { 1: ['A'] } });
    const { engine, queryClient } = await boot({
      storage,
      outbox: createMemoryOutbox(),
      transport,
    });
    await fetchMe(queryClient, me(userId, [orgId, otherOrgId]));
    for (const org of [orgId, otherOrgId]) {
      await queryClient.fetchQuery({
        queryKey: myListKey(org),
        queryFn: () => engine.pipeline.fetch(org),
      });
      queryClient.setQueryData(['tags', org], [{ id: `tag-${org}`, orgId: org, name: org }]);
      queryClient.setQueryData(['task', `task-${org}`], { id: `task-${org}`, orgId: org });
      queryClient.setQueryData(['trash', org], { items: [] });
      queryClient.setQueryData(['search', org, 'a'], []);
    }
    queryClient.setQueryData(['search', 'all', 'a'], [{ orgId: otherOrgId }]);
    queryClient.setQueryData(['search', 'all', 'b'], [{ orgId }]);

    await fetchMe(queryClient, me(userId, [orgId]));
    const keys = queryClient
      .getQueryCache()
      .getAll()
      .map((q) => JSON.stringify(q.queryKey));
    expect(keys.filter((k) => k.includes(otherOrgId))).toEqual([]);
    expect(keys).not.toContain('["search","all","a"]');
    expect(keys).toEqual(
      expect.arrayContaining([
        JSON.stringify(myListKey(orgId)),
        JSON.stringify(['tags', orgId]),
        JSON.stringify(['task', `task-${orgId}`]),
        '["search","all","b"]',
      ]),
    );
    expect(engine.pipeline.baseOf(otherOrgId)).toBeUndefined();
    expect(engine.pipeline.baseOf(orgId)).toBeDefined();
    // The next save leaves the revoked org out of IndexedDB too.
    await vi.waitFor(() => expect(data.get(cacheStorageKey)).toContain(orgId), { timeout: 6000 });
    expect(data.get(cacheStorageKey)).not.toContain(otherOrgId);
  });

  test('AC-1.0.1 queued ops of an org missing from the first fresh /me are discarded unsent', async () => {
    const { storage } = memoryStorage();
    const outbox = createMemoryOutbox();
    const transport = createFixtureTransport({ userId, tasks: { 1: ['A'] } });
    localStorage.setItem('rooster.cacheOwner', userId);
    const { engine, queryClient } = await boot({ storage, outbox, transport });
    const state = await queryClient.fetchQuery({
      queryKey: myListKey(otherOrgId),
      queryFn: () => engine.pipeline.fetch(otherOrgId),
    });
    const today = Object.values(state.groups).find((g) => g.name === 'Today')?.id as string;
    engine.pipeline.enqueue(
      otherOrgId,
      [listOps.createTask({ id: 'n1', title: 'Revoked', groupId: today })],
      { userId },
    );
    await vi.waitFor(() => expect(outbox.records.size).toBe(1));
    expect([...outbox.records.values()][0]?.userId).toBe(userId);

    await fetchMe(queryClient, me(userId, [orgId]));
    await engine.pipeline.idle();
    expect(engine.pipeline.pending).toBe(0);
    expect(transport.state(otherOrgId).tasks.n1).toBeUndefined();
    await vi.waitFor(() => expect(outbox.records.size).toBe(0));
  });

  test('AC-1.0.1 outbox records of another user are dropped, never sent', async () => {
    const { storage } = memoryStorage();
    const outbox = createMemoryOutbox();
    const transport = createFixtureTransport({ userId, tasks: { 1: ['A'] } });
    localStorage.setItem('rooster.cacheOwner', userId);
    await outbox.put([
      {
        op: { ...listOps.deleteTask('x'), opId: 'op-1', editTime: 1, clientId: 'c' },
        orgId,
        ctx: { userId: 'intruder' },
        userId: 'intruder',
      },
    ]);
    const { engine, queryClient } = await boot({ storage, outbox, transport });
    expect(engine.pipeline.pending).toBe(0);
    await fetchMe(queryClient, me(userId));
    await engine.pipeline.idle();
    await vi.waitFor(() => expect(outbox.records.size).toBe(0));
  });

  test('AC-1.0.1 a cache last confirmed more than 30 days ago is deleted, not rendered', async () => {
    const { data, storage } = memoryStorage();
    const transport = createFixtureTransport({ userId, tasks: { 1: ['Secret'] } });
    localStorage.setItem('rooster.cacheOwner', userId);
    const first = await boot({ storage, outbox: createMemoryOutbox(), transport });
    first.persister.confirmed(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await first.queryClient.fetchQuery({
      queryKey: myListKey(orgId),
      queryFn: () => first.engine.pipeline.fetch(orgId),
    });
    await vi.waitFor(() => expect(data.get(cacheStorageKey)).toContain('Secret'), {
      timeout: 6000,
    });
    first.engine.stop();

    const second = await boot({ storage, outbox: createMemoryOutbox(), transport });
    expect(second.queryClient.getQueryData(myListKey(orgId))).toBeUndefined();
    expect(data.has(cacheStorageKey)).toBe(false);
  });

  test('a clear posted by another tab while this one restores still clears and reloads', async () => {
    let handler: ((m: SyncMessage) => void) | null = null;
    const channel: SyncChannel = {
      ...nullChannel(),
      listen: (h) => {
        handler = h;
        return () => {
          handler = null;
        };
      },
    };
    const outbox = createMemoryOutbox();
    const load = outbox.load.bind(outbox);
    let restoring = true;
    outbox.load = async () => {
      // Signed out (or another account signed in) in another tab during this tab's restore.
      if (restoring) (handler as ((m: SyncMessage) => void) | null)?.({ type: 'cleared' });
      restoring = false;
      return load();
    };
    const reload = vi.fn();
    vi.stubGlobal('location', { ...globalThis.location, reload });
    try {
      const queryClient = new QueryClient();
      queryClient.setQueryData(myListKey(orgId), { private: true });
      const { engine } = await boot(
        {
          storage: memoryStorage().storage,
          outbox,
          transport: createFixtureTransport({ userId }),
          channel,
        },
        queryClient,
      );
      await vi.waitFor(() => expect(reload).toHaveBeenCalled());
      expect(queryClient.getQueryData(myListKey(orgId))).toBeUndefined();
      expect(engine.pipeline.pending).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('a cache restore that outlasts the start-up wait is discarded, not hydrated later', async () => {
    const { data, storage } = memoryStorage();
    const transport = createFixtureTransport({ userId, tasks: { 1: ['Secret'] } });
    localStorage.setItem('rooster.cacheOwner', userId);
    const first = await boot({ storage, outbox: createMemoryOutbox(), transport });
    first.persister.confirmed(Date.now());
    await first.queryClient.fetchQuery({
      queryKey: myListKey(orgId),
      queryFn: () => first.engine.pipeline.fetch(orgId),
    });
    await vi.waitFor(() => expect(data.get(cacheStorageKey)).toContain('Secret'), {
      timeout: 6000,
    });
    first.engine.stop();

    // IndexedDB answers only after start-up gave up waiting.
    let answer: () => void = () => {};
    const slow: KeyValueStorage = {
      ...storage,
      get: (key) => {
        const value = data.get(key);
        return new Promise((resolve) => (answer = () => resolve(value)));
      },
    };
    const queryClient = new QueryClient();
    const persister = createCachePersister(() => undefined, slow);
    const engine = await startSync({
      queryClient,
      transport,
      outbox: createMemoryOutbox(),
      channel: nullChannel(),
      persister,
      eventSource: quietSource,
      locks: null,
      listen: false,
      restoreTimeoutMs: 10,
    });
    engines.push(engine);
    // Another account signs in meanwhile.
    const other = '01900000-0000-7000-8000-000000000002';
    await fetchMe(queryClient, me(other));
    answer();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(queryClient.getQueryData(myListKey(orgId))).toBeUndefined();
    expect((queryClient.getQueryData(['me']) as Me).user.id).toBe(other);
  });
});

/** BroadcastChannel stand-in: delivers to every other member; a member can freeze or drop. */
function bus() {
  interface Member {
    handler: ((m: SyncMessage) => void) | null;
    frozen: SyncMessage[] | null;
    drop: (m: SyncMessage) => boolean;
  }
  const members: Member[] = [];
  const deliver = (member: Member, m: SyncMessage) => {
    if (member.drop(m)) return;
    if (member.frozen) member.frozen.push(m);
    else member.handler?.(structuredClone(m));
  };
  const join = () => {
    const self: Member = { handler: null, frozen: null, drop: () => false };
    members.push(self);
    const channel: SyncChannel = {
      post: (m) => {
        if (self.frozen) return;
        for (const member of members) {
          if (member !== self) queueMicrotask(() => deliver(member, m));
        }
      },
      listen: (h) => {
        self.handler = h;
        return () => {
          self.handler = null;
        };
      },
      close: () => {},
    };
    return {
      channel,
      /** Like a frozen page: receives nothing now, everything once thawed. */
      freeze: () => {
        self.frozen = [];
      },
      thaw: () => {
        const queued = self.frozen ?? [];
        self.frozen = null;
        for (const m of queued) self.handler?.(structuredClone(m));
      },
      dropWhen: (drop: (m: SyncMessage) => boolean) => {
        self.drop = drop;
      },
    };
  };
  return { join };
}

describe('leader watch (a frozen leader must not block the tab in front)', () => {
  const watch = { stallMs: 30, answerMs: 30, recheckMs: 30 };

  async function bootTab(
    deps: {
      outbox: ReturnType<typeof createMemoryOutbox>;
      transport: ListTransport;
      channel: SyncChannel;
      locks: ReturnType<typeof fakeLocks>;
    },
    queryClient = new QueryClient(),
  ) {
    const engine = await startSync({
      queryClient,
      transport: deps.transport,
      outbox: deps.outbox,
      channel: deps.channel,
      persister: createCachePersister(() => undefined, memoryStorage().storage),
      eventSource: quietSource,
      locks: deps.locks,
      listen: false,
      leaderWatch: watch,
    });
    engines.push(engine);
    await fetchMe(queryClient, me(userId));
    await queryClient.fetchQuery({
      queryKey: myListKey(orgId),
      queryFn: () => engine.pipeline.fetch(orgId),
    });
    return { engine, queryClient };
  }

  function counting(inner: ReturnType<typeof createFixtureTransport>) {
    const sent: string[] = [];
    const transport: ListTransport = {
      ...inner,
      send: (op, org, signal) => {
        sent.push(op.opId);
        return inner.send(op, org, signal);
      },
    };
    return { transport, sent };
  }

  function todayOf(engine: SyncEngine) {
    const state = engine.pipeline.view(orgId);
    return Object.values(state?.groups ?? {}).find((g) => g.name === 'Today')?.id as string;
  }

  test('a follower whose leader does not answer takes the lock and sends its ops', async () => {
    localStorage.setItem('rooster.cacheOwner', userId);
    const outbox = createMemoryOutbox();
    const server = createFixtureTransport({ userId, tasks: { 1: ['A'] } });
    const { transport, sent } = counting(server);
    const locks = fakeLocks();
    const net = bus();
    const pwa = net.join();
    const tab = net.join();
    const a = await bootTab({ outbox, transport, channel: pwa.channel, locks });
    await vi.waitFor(() => expect(useSyncStore.getState().leader).toBe(true));
    const b = await bootTab({ outbox, transport, channel: tab.channel, locks });

    // The leader goes to the background and is frozen: it holds the lock, hears nothing.
    pwa.freeze();
    const [op] = b.engine.pipeline.enqueue(
      orgId,
      [listOps.createTask({ id: 'n1', title: 'From the front', groupId: todayOf(b.engine) })],
      { userId },
    );
    await vi.waitFor(() => expect(b.engine.pipeline.pending).toBe(0));
    expect(server.state(orgId).tasks.n1?.title).toBe('From the front');
    expect(sent).toEqual([op?.opId]);
    expect(locks.holders()).toBe(1);
    await vi.waitFor(() => expect(outbox.records.size).toBe(0));

    // Thawed, the old leader hears it lost the lock, catches up and does not send again.
    pwa.thaw();
    await vi.waitFor(() => expect(a.engine.pipeline.pending).toBe(0));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sent).toEqual([op?.opId]);
  });

  test('a follower whose leader answers keeps following, and drops ops settled meanwhile', async () => {
    localStorage.setItem('rooster.cacheOwner', userId);
    const outbox = createMemoryOutbox();
    const server = createFixtureTransport({ userId, tasks: { 1: ['A'] } });
    const { transport, sent } = counting(server);
    const locks = fakeLocks();
    const net = bus();
    const pwa = net.join();
    const tab = net.join();
    const a = await bootTab({ outbox, transport, channel: pwa.channel, locks });
    await vi.waitFor(() => expect(useSyncStore.getState().leader).toBe(true));
    const b = await bootTab({ outbox, transport, channel: tab.channel, locks });
    // The confirmation never reaches the follower (it was starting, or frozen and discarded).
    tab.dropWhen((m) => m.type === 'applied');

    b.engine.pipeline.enqueue(
      orgId,
      [listOps.createTask({ id: 'n1', title: 'Confirmed unseen', groupId: todayOf(b.engine) })],
      { userId },
    );
    await vi.waitFor(() => expect(server.state(orgId).tasks.n1).toBeDefined());
    await vi.waitFor(() => expect(outbox.records.size).toBe(0));
    // The stale mirror is corrected against the outbox, without a takeover or a resend.
    await vi.waitFor(() => expect(b.engine.pipeline.pending).toBe(0));
    expect(sent).toHaveLength(1);
    expect(a.engine.pipeline.pending).toBe(0);
    await vi.waitFor(() =>
      expect(
        tasksInGroup(b.engine.pipeline.view(orgId) as ListState, todayOf(b.engine)).map(
          (t) => t.title,
        ),
      ).toContain('Confirmed unseen'),
    );
  });

  test('a confirmation posted while a tab is still starting is not lost', async () => {
    localStorage.setItem('rooster.cacheOwner', userId);
    const outbox = createMemoryOutbox();
    const net = bus();
    const leader = net.join();
    const tab = net.join();
    const locks = fakeLocks();
    electLeader(() => {}, locks);
    const op = { ...listOps.deleteTask('x'), opId: 'op-1', editTime: 1, clientId: 'c' };
    await outbox.put([{ op, orgId, ctx: { userId }, userId }]);
    // The leader confirms the op right after this tab read the outbox, before it listens.
    const load = outbox.load.bind(outbox);
    let first = true;
    outbox.load = async () => {
      const records = await load();
      if (first) {
        first = false;
        await outbox.remove(['op-1']);
        leader.channel.post({ type: 'applied', opId: 'op-1', response: undefined });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return records;
    };
    const engine = await startSync({
      queryClient: new QueryClient(),
      transport: createFixtureTransport({ userId }),
      outbox,
      channel: tab.channel,
      persister: createCachePersister(() => undefined, memoryStorage().storage),
      eventSource: quietSource,
      locks,
      listen: false,
      leaderWatch: { stallMs: 60_000, answerMs: 60_000 },
    });
    engines.push(engine);
    await vi.waitFor(() => expect(engine.pipeline.pending).toBe(0));
  });
});

describe('update check (FR-PWA-6, 04 §6.3)', () => {
  test('a newer server in `hello` runs the check, also one set after the hello', async () => {
    const hellos: ((event: MessageEvent<string>) => void)[] = [];
    const source = (): EventSourceLike => ({
      readyState: 0,
      onopen: null,
      onerror: null,
      addEventListener: (type, listener) => {
        if (type === 'hello') hellos.push(listener);
      },
      close: () => {},
    });
    const queryClient = new QueryClient();
    const engine = await startSync({
      queryClient,
      transport: createFixtureTransport({ userId, tasks: { 1: ['A'] } }),
      outbox: createMemoryOutbox(),
      channel: nullChannel(),
      persister: createCachePersister(() => undefined, memoryStorage().storage),
      eventSource: source,
      locks: null,
      listen: false,
    });
    engines.push(engine);
    await fetchMe(queryClient, me(userId));
    await vi.waitFor(() => expect(hellos.length).toBe(1));
    const hello = (version: string) =>
      hellos[0]?.({ data: JSON.stringify({ version, gitSha: 'x', serverTime: 1 }) } as never);

    const early = vi.fn();
    engine.setUpdateCheck(early);
    hello('0.0.0');
    expect(early).not.toHaveBeenCalled();
    hello('99.0.0');
    expect(early).toHaveBeenCalledOnce();

    const late = vi.fn();
    engine.setUpdateCheck(late);
    expect(late).toHaveBeenCalledOnce();
  });
});
