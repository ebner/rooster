import { emptyListState } from '@rooster/core/reducers';
import type { PersistedClient } from '@tanstack/react-query-persist-client';
import { describe, expect, test } from 'vitest';
import {
  cacheStorageKey,
  createCachePersister,
  isPersistedQuery,
  type KeyValueStorage,
  legacyCacheStorageKey,
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
      keys: async () => [...data.keys()],
    };
    let owner: string | null = 'u1';
    const persister = createCachePersister(
      () => undefined,
      storage,
      Date.now,
      () => owner,
    );
    persister.confirmed(Date.now());
    await persister.persistClient(client([query(['me'], { user: { id: 'u1' } })]));
    expect(data.has(cacheStorageKey('u1'))).toBe(true);
    expect((await persister.restoreClient())?.clientState.queries[0]?.state.data).toEqual({
      user: { id: 'u1' },
    });
    // Sign-out: the owner goes first, then every snapshot.
    owner = null;
    await persister.removeClient();
    await persister.suspend();
    await persister.persistClient(client([query(['me'], { user: { id: 'u2' } })]));
    expect(data.has(cacheStorageKey('u1'))).toBe(false);
    expect(await persister.restoreClient()).toBeUndefined();
  });

  describe('one snapshot per account (ADR 0051/0056)', () => {
    function memory() {
      const data = new Map<string, string>();
      const storage: KeyValueStorage = {
        get: async (k) => data.get(k),
        set: async (k, v) => void data.set(k, v),
        del: async (k) => void data.delete(k),
        keys: async () => [...data.keys()],
      };
      return { data, storage };
    }
    const snapshot = (id: string) => client([query(['me'], { user: { id } }, Date.now())]);

    test('a snapshot is stored under the account its /me names; without /me, not at all', async () => {
      const { data, storage } = memory();
      const persister = createCachePersister(
        () => undefined,
        storage,
        Date.now,
        () => 'u1',
      );
      await persister.persistClient(snapshot('u2'));
      expect([...data.keys()]).toEqual([cacheStorageKey('u2')]);
      await persister.persistClient(client([query(['tags', 'o'], [])]));
      expect([...data.keys()]).toEqual([cacheStorageKey('u2')]);
    });

    test("a foreign account's snapshot is never restored, whatever is stored", async () => {
      const { storage } = memory();
      let owner: string | null = 'u2';
      const persister = createCachePersister(
        () => undefined,
        storage,
        Date.now,
        () => owner,
      );
      persister.confirmed(Date.now());
      await persister.persistClient(snapshot('u2'));
      owner = 'u1';
      expect(await persister.restoreClient()).toBeUndefined();
      owner = null;
      expect(await persister.restoreClient()).toBeUndefined();
      owner = 'u2';
      expect(await persister.restoreClient()).toBeDefined();
    });

    test('cleanup by key never touches the account taking over, even mid-save', async () => {
      const { data, storage } = memory();
      // Both tabs read the one owner of the browser (localStorage): B took over.
      let owner: string | null = 'u2';
      const tabA = createCachePersister(
        () => undefined,
        storage,
        Date.now,
        () => owner,
      );
      const tabB = createCachePersister(
        () => undefined,
        storage,
        Date.now,
        () => owner,
      );
      await tabA.persistClient(snapshot('u1'));
      // Tab A removes the ending account while tab B saves the new one: no read-then-delete.
      await Promise.all([tabA.removeFor('u1'), tabB.persistClient(snapshot('u2'))]);
      expect([...data.keys()]).toEqual([cacheStorageKey('u2')]);
      await tabA.persistClient(snapshot('u1'));
      await Promise.all([tabA.removeExcept('u2'), tabB.persistClient(snapshot('u2'))]);
      expect([...data.keys()]).toEqual([cacheStorageKey('u2')]);
      // A sign-out elsewhere (owner still u2) leaves the owner's snapshot; once no one owns
      // the browser, everything goes.
      await tabA.removeClient();
      expect([...data.keys()]).toEqual([cacheStorageKey('u2')]);
      owner = null;
      await tabA.removeClient();
      expect(data.size).toBe(0);
    });

    test('no snapshot of an account whose session ended is saved until it is confirmed again', async () => {
      const { data, storage } = memory();
      const persister = createCachePersister(
        () => undefined,
        storage,
        Date.now,
        () => 'u1',
      );
      persister.setExpired('u1', true);
      await persister.persistClient(snapshot('u1'));
      await persister.persistClient(snapshot('u2'));
      expect([...data.keys()]).toEqual([cacheStorageKey('u2')]);
      persister.setExpired('u1', false);
      await persister.persistClient(snapshot('u1'));
      expect(data.has(cacheStorageKey('u1'))).toBe(true);
    });

    test('start-up housekeeping stops once another tab changed the owner', async () => {
      const { data, storage } = memory();
      let owner: string | null = 'u1';
      const persister = createCachePersister(
        () => undefined,
        storage,
        Date.now,
        () => owner,
      );
      await persister.persistClient(snapshot('u1'));
      // The start's listing is slow; another tab signs in as u2 and saves meanwhile.
      const listKeys = storage.keys;
      storage.keys = async () => {
        const found = await listKeys();
        owner = 'u2';
        data.set(cacheStorageKey('u2'), 'the new account');
        return [...found, cacheStorageKey('u2')];
      };
      await persister.tidy('u1');
      expect(data.get(cacheStorageKey('u2'))).toBe('the new account');
      // Even without the fence, the owner's own snapshot is never deleted.
      storage.keys = listKeys;
      owner = 'u2';
      await persister.removeExcept('u1');
      expect(data.get(cacheStorageKey('u2'))).toBe('the new account');
    });

    test('a start keeps only the owner: the old account-less snapshot moves to it, or goes', async () => {
      const { data, storage } = memory();
      let owner: string | null = 'u1';
      const persister = createCachePersister(
        () => undefined,
        storage,
        Date.now,
        () => owner,
      );
      persister.confirmed(Date.now());
      await persister.persistClient(snapshot('u1'));
      const own = data.get(cacheStorageKey('u1')) as string;
      data.delete(cacheStorageKey('u1'));
      data.set(legacyCacheStorageKey, own);
      await persister.persistClient(snapshot('u3'));
      data.set('unrelated', 'kept');
      await persister.tidy('u1');
      expect([...data.keys()].sort()).toEqual([cacheStorageKey('u1'), 'unrelated'].sort());
      expect(await persister.restoreClient()).toBeDefined();
      // Someone else's old snapshot is not migrated; with no owner every snapshot goes.
      data.set(legacyCacheStorageKey, own);
      owner = 'u2';
      await persister.tidy('u2');
      expect(data.has(legacyCacheStorageKey)).toBe(false);
      expect(data.has(cacheStorageKey('u2'))).toBe(false);
      owner = null;
      await persister.tidy(null);
      expect([...data.keys()]).toEqual(['unrelated']);
    });
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
        keys: async () => [...data.keys()],
      };
      return { data, storage };
    }

    test('stores the confirmation time and restores within 30 days', async () => {
      const { data, storage } = memory();
      const writer = createCachePersister(
        () => undefined,
        storage,
        () => now,
        () => 'u1',
      );
      writer.confirmed(now - 29 * day);
      await writer.persistClient(client([query(['me'], { user: { id: 'u1' } })]));
      expect(JSON.parse(data.get(cacheStorageKey('u1')) ?? '{}').confirmedAt).toBe(now - 29 * day);
      const reader = createCachePersister(
        () => undefined,
        storage,
        () => now,
        () => 'u1',
      );
      expect(await reader.restoreClient()).toBeDefined();
      // The restored confirmation carries over into the next save.
      await reader.persistClient(client([query(['me'], { user: { id: 'u1' } })]));
      expect(JSON.parse(data.get(cacheStorageKey('u1')) ?? '{}').confirmedAt).toBe(now - 29 * day);
    });

    test('deletes instead of restoring a cache confirmed more than 30 days ago', async () => {
      const { data, storage } = memory();
      const writer = createCachePersister(
        () => undefined,
        storage,
        () => now,
        () => 'u1',
      );
      writer.confirmed(now - 31 * day);
      await writer.persistClient(client([query(['me'], { user: { id: 'u1' } })]));
      const reader = createCachePersister(
        () => undefined,
        storage,
        () => now,
        () => 'u1',
      );
      expect(await reader.restoreClient()).toBeUndefined();
      expect(data.has(cacheStorageKey('u1'))).toBe(false);
    });

    test('deletes a cache that was never confirmed', async () => {
      const { data, storage } = memory();
      const writer = createCachePersister(
        () => undefined,
        storage,
        () => now,
        () => 'u1',
      );
      await writer.persistClient(client([query(['me'], { user: { id: 'u1' } })]));
      expect(await writer.restoreClient()).toBeUndefined();
      expect(data.has(cacheStorageKey('u1'))).toBe(false);
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
        () => 'u1',
      );
      data.set(cacheStorageKey('u1'), legacy(now - day));
      expect(await reader.restoreClient()).toBeDefined();
      data.set(cacheStorageKey('u1'), legacy(now - 31 * day));
      expect(await reader.restoreClient()).toBeUndefined();
      expect(data.has(cacheStorageKey('u1'))).toBe(false);
    });
  });
});
