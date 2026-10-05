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
});
