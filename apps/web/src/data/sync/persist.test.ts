import { emptyListState } from '@rooster/core/reducers';
import type { PersistedClient } from '@tanstack/react-query-persist-client';
import { describe, expect, test } from 'vitest';
import {
  cacheStorageKey,
  createCachePersister,
  isPersistedQuery,
  type KeyValueStorage,
  maxPersistedTaskDetails,
  prepareForPersist,
} from './persist';

type DehydratedQuery = PersistedClient['clientState']['queries'][number];

function query(queryKey: unknown[], data: unknown, dataUpdatedAt = 0): DehydratedQuery {
  return {
    queryKey,
    queryHash: JSON.stringify(queryKey),
    state: { data, dataUpdatedAt, status: 'success' },
  } as unknown as DehydratedQuery;
}

function client(queries: DehydratedQuery[]): PersistedClient {
  return { timestamp: 0, buster: '0', clientState: { queries, mutations: [] } };
}

describe('persisted query cache (04 §6.1)', () => {
  test('persists me, my-list, tags, task and notifications only', () => {
    const ok = (key: unknown[]) =>
      isPersistedQuery({ queryKey: key, state: { status: 'success' } } as never);
    expect(['me', 'my-list', 'tags', 'task', 'notifications'].every((r) => ok([r, 'x']))).toBe(
      true,
    );
    expect(ok(['org-members', 'x'])).toBe(false);
    expect(ok(['sessions'])).toBe(false);
    expect(isPersistedQuery({ queryKey: ['me'], state: { status: 'error' } } as never)).toBe(false);
  });

  test('stores the confirmed my-list base, 200 most recent details, first notification page', () => {
    const view = { ...emptyListState('o1'), serverTime: 2 };
    const base = { ...emptyListState('o1'), serverTime: 1 };
    const tasks = Array.from({ length: maxPersistedTaskDetails + 5 }, (_, i) =>
      query(['task', `t${i}`], { id: `t${i}` }, i),
    );
    const prepared = prepareForPersist(
      client([
        query(['my-list', 'o1'], view),
        query(['my-list', 'o2'], view),
        query(['notifications'], { pages: [1, 2], pageParams: [0, 1] }),
        ...tasks,
      ]),
      (org) => (org === 'o1' ? base : undefined),
    );
    const byKey = new Map(prepared.clientState.queries.map((q) => [q.queryHash, q.state.data]));
    expect(byKey.get('["my-list","o1"]')).toBe(base);
    expect(byKey.get('["my-list","o2"]')).toBe(view);
    expect(byKey.get('["notifications"]')).toEqual({ pages: [1], pageParams: [0] });
    const kept = prepared.clientState.queries.filter((q) => q.queryKey[0] === 'task');
    expect(kept).toHaveLength(maxPersistedTaskDetails);
    expect(byKey.has('["task","t0"]')).toBe(false);
    expect(byKey.has(`["task","t${maxPersistedTaskDetails + 4}"]`)).toBe(true);
  });

  test('round-trips through storage; a suspended persister writes nothing more', async () => {
    const data = new Map<string, string>();
    const storage: KeyValueStorage = {
      get: async (k) => data.get(k),
      set: async (k, v) => void data.set(k, v),
      del: async (k) => void data.delete(k),
    };
    const persister = createCachePersister(() => undefined, storage);
    persister.confirmed(Date.now());
    await persister.persistClient(client([query(['me'], { user: { id: 'u1' } })]));
    expect(data.has(cacheStorageKey)).toBe(true);
    expect((await persister.restoreClient())?.clientState.queries[0]?.state.data).toEqual({
      user: { id: 'u1' },
    });
    await persister.removeClient();
    await persister.suspend();
    await persister.persistClient(client([query(['me'], { user: { id: 'u2' } })]));
    expect(data.has(cacheStorageKey)).toBe(false);
    expect(await persister.restoreClient()).toBeUndefined();
  });

  test("a sign-out elsewhere deletes the ending account's snapshot, never another's", async () => {
    const data = new Map<string, string>();
    const storage: KeyValueStorage = {
      get: async (k) => data.get(k),
      set: async (k, v) => void data.set(k, v),
      del: async (k) => void data.delete(k),
    };
    const persister = createCachePersister(() => undefined, storage);
    await persister.persistClient(client([query(['me'], { user: { id: 'u2' } })]));
    await persister.suspend();
    await persister.removeOwnedBy('u1');
    expect(data.has(cacheStorageKey)).toBe(true);
    await persister.removeOwnedBy('u2');
    expect(data.has(cacheStorageKey)).toBe(false);
    // A snapshot that names no one could be anyone's.
    data.set(cacheStorageKey, '{"timestamp":0,"buster":"","queries":[]}');
    await persister.removeOwnedBy('u1');
    expect(data.has(cacheStorageKey)).toBe(false);
    data.set(cacheStorageKey, 'not json');
    await persister.removeOwnedBy('u1');
    expect(data.has(cacheStorageKey)).toBe(false);
  });

  describe('AC-1.0.1 a cache is restored only while its last confirmed /me is recent', () => {
    const day = 24 * 60 * 60 * 1000;
    const now = Date.UTC(2026, 9, 8);
    function memory() {
      const data = new Map<string, string>();
      const storage: KeyValueStorage = {
        get: async (k) => data.get(k),
        set: async (k, v) => void data.set(k, v),
        del: async (k) => void data.delete(k),
      };
      return { data, storage };
    }

    test('stores the confirmation time and restores within 30 days', async () => {
      const { data, storage } = memory();
      const writer = createCachePersister(
        () => undefined,
        storage,
        () => now,
      );
      writer.confirmed(now - 29 * day);
      await writer.persistClient(client([query(['me'], { user: { id: 'u1' } })]));
      expect(JSON.parse(data.get(cacheStorageKey) ?? '{}').confirmedAt).toBe(now - 29 * day);
      const reader = createCachePersister(
        () => undefined,
        storage,
        () => now,
      );
      expect(await reader.restoreClient()).toBeDefined();
      // The restored confirmation carries over into the next save.
      await reader.persistClient(client([query(['me'], { user: { id: 'u1' } })]));
      expect(JSON.parse(data.get(cacheStorageKey) ?? '{}').confirmedAt).toBe(now - 29 * day);
    });

    test('deletes instead of restoring a cache confirmed more than 30 days ago', async () => {
      const { data, storage } = memory();
      const writer = createCachePersister(
        () => undefined,
        storage,
        () => now,
      );
      writer.confirmed(now - 31 * day);
      await writer.persistClient(client([query(['me'], { user: { id: 'u1' } })]));
      const reader = createCachePersister(
        () => undefined,
        storage,
        () => now,
      );
      expect(await reader.restoreClient()).toBeUndefined();
      expect(data.has(cacheStorageKey)).toBe(false);
    });

    test('deletes a cache that was never confirmed', async () => {
      const { data, storage } = memory();
      const writer = createCachePersister(
        () => undefined,
        storage,
        () => now,
      );
      await writer.persistClient(client([query(['me'], { user: { id: 'u1' } })]));
      expect(await writer.restoreClient()).toBeUndefined();
      expect(data.has(cacheStorageKey)).toBe(false);
    });

    test('a cache from before 1.0.1 counts from its stored /me fetch time', async () => {
      const { data, storage } = memory();
      const legacy = (meAt: number) =>
        JSON.stringify({
          timestamp: now,
          buster: '0',
          queries: [
            {
              q: { queryKey: ['me'], queryHash: '["me"]', state: { dataUpdatedAt: meAt } },
              d: { user: { id: 'u1' } },
            },
          ],
        });
      const reader = createCachePersister(
        () => undefined,
        storage,
        () => now,
      );
      data.set(cacheStorageKey, legacy(now - day));
      expect(await reader.restoreClient()).toBeDefined();
      data.set(cacheStorageKey, legacy(now - 31 * day));
      expect(await reader.restoreClient()).toBeUndefined();
      expect(data.has(cacheStorageKey)).toBe(false);
    });
  });
});
