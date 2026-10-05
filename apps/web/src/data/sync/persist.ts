import type { ListState } from '@rooster/core/reducers';
import type { DehydrateOptions, Query, QueryClient } from '@tanstack/react-query';
import type { PersistedClient, Persister } from '@tanstack/react-query-persist-client';
import { del, get, set } from 'idb-keyval';

/** 04 §6.1: the IndexedDB key of the persisted query cache. */
export const cacheStorageKey = 'rooster-cache-v1';
/** 04 §6.1: older caches are discarded. */
export const cacheMaxAgeMs = 30 * 24 * 60 * 60 * 1000;
/**
 * Saves wait for a pause in editing (the list changes on every keypress) and then for an idle
 * moment, but never longer than the max wait. Serialising 600 tasks is a long task that would
 * otherwise land inside a keypress's frame (AC-2.12); `pagehide` and hiding the tab save at once.
 */
export const cacheSaveDebounceMs = 2_000;
export const cacheSaveMaxWaitMs = 15_000;
/** 04 §6.1: only the most recently used task details are kept. */
export const maxPersistedTaskDetails = 200;

/** 04 §5.1 / §6.1: the query roots readable offline. */
export const persistedRoots: ReadonlySet<string> = new Set([
  'me',
  'my-list',
  'tags',
  'task',
  'notifications',
]);

export function isPersistedQuery(query: Pick<Query, 'queryKey' | 'state'>): boolean {
  const root = query.queryKey[0];
  return typeof root === 'string' && persistedRoots.has(root) && query.state.status === 'success';
}

export const persistDehydrateOptions: DehydrateOptions = {
  shouldDehydrateQuery: isPersistedQuery,
  // Plain mutations are online-only (hard rule 4); list ops live in the outbox.
  shouldDehydrateMutation: () => false,
};

/**
 * Shapes a dehydrated cache for storage:
 * - `['my-list', org]` stores the last server-confirmed state, not the optimistic view: the
 *   outbox replays the pending ops on top after a reload, exactly once.
 * - only the 200 task details fetched or updated most recently are kept;
 * - an infinite list (`['notifications']`) keeps its first page.
 */
export function prepareForPersist(
  client: PersistedClient,
  baseOf: (orgId: string) => ListState | undefined,
): PersistedClient {
  const tasks = client.clientState.queries
    .filter((q) => q.queryKey[0] === 'task')
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)
    .slice(0, maxPersistedTaskDetails);
  const keep = new Set(tasks);
  const queries = client.clientState.queries.flatMap((query) => {
    const [root, id] = query.queryKey;
    if (root === 'task' && !keep.has(query)) return [];
    if (root === 'my-list' && typeof id === 'string') {
      const base = baseOf(id);
      return [base ? { ...query, state: { ...query.state, data: base } } : query];
    }
    const data = query.state.data as { pages?: unknown[]; pageParams?: unknown[] } | undefined;
    if (root === 'notifications' && Array.isArray(data?.pages)) {
      const first = {
        pages: data.pages.slice(0, 1),
        pageParams: (data.pageParams ?? []).slice(0, 1),
      };
      return [{ ...query, state: { ...query.state, data: first } }];
    }
    return [query];
  });
  return { ...client, clientState: { ...client.clientState, queries } };
}

/** The restored confirmed `my-list` states, for the pipeline to adopt. */
export function restoredBases(queryClient: QueryClient): Map<string, ListState> {
  const bases = new Map<string, ListState>();
  for (const [key, data] of queryClient.getQueriesData<ListState>({ queryKey: ['my-list'] })) {
    const orgId = key[1];
    if (typeof orgId === 'string' && data) bases.set(orgId, data);
  }
  return bases;
}

/**
 * Persisted roots stay in memory: otherwise an org not looked at for 5 minutes would be
 * garbage-collected and then dropped from storage too. (Infinity, not the 30-day max age: a
 * timer that long overflows and would collect at once.)
 */
export function keepPersistedQueries(queryClient: QueryClient): void {
  for (const root of persistedRoots) {
    queryClient.setQueryDefaults([root], { gcTime: Number.POSITIVE_INFINITY });
  }
}

export interface CachePersister extends Persister {
  /** Stops writing (sign-out): a save still in flight is awaited, later ones are ignored. */
  suspend(): Promise<void>;
}

/** The stored shape: each query's data apart from its metadata (see `serialize`). */
interface StoredClient {
  timestamp: number;
  buster: string;
  queries: {
    q: Omit<PersistedClient['clientState']['queries'][number], 'state'> & {
      state: Record<string, unknown>;
    };
    d: unknown;
  }[];
}

export interface KeyValueStorage {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
}

const idbStorage: KeyValueStorage = {
  get: (key) => get<string>(key),
  set: (key, value) => set(key, value),
  del: (key) => del(key),
};

/**
 * The IndexedDB persister (idb-keyval, key `rooster-cache-v1`). Writes are serialised; the
 * sync engine throttles them (1 s) with a timer it can cancel, so no delayed save writes the
 * previous user's data back after a sign-out.
 */
export function createCachePersister(
  baseOf: (orgId: string) => ListState | undefined,
  storage: KeyValueStorage = idbStorage,
): CachePersister {
  let suspended = false;
  let writing: Promise<void> = Promise.resolve();
  const chain = (run: () => Promise<void>) => {
    writing = writing
      .then(run)
      .catch((error: unknown) => console.warn('rooster: cache write failed', error));
    return writing;
  };
  // Query data is immutable (every change makes a new object and keeps untouched children),
  // so values are serialised once and reused: a save re-serialises only what changed, down to
  // the single task of a 600-task list (AC-2.12: no long task while the user types).
  const memo = new WeakMap<object, string>();
  const json = (value: unknown, depth: number): string => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
    const cached = memo.get(value);
    if (cached !== undefined) return cached;
    let out: string;
    if (depth === 0) out = JSON.stringify(value);
    else if (Array.isArray(value)) out = `[${value.map((v) => json(v, depth - 1)).join(',')}]`;
    else {
      const parts: string[] = [];
      for (const [key, v] of Object.entries(value)) {
        if (v !== undefined) parts.push(`${JSON.stringify(key)}:${json(v, depth - 1)}`);
      }
      out = `{${parts.join(',')}}`;
    }
    memo.set(value, out);
    return out;
  };
  const serialize = (client: PersistedClient): string => {
    const queries = client.clientState.queries.map(({ state, ...query }) => {
      const { data, ...rest } = state;
      return `{"q":${JSON.stringify({ ...query, state: rest })},"d":${json(data, 3)}}`;
    });
    return `{"timestamp":${client.timestamp},"buster":${JSON.stringify(client.buster)},"queries":[${queries.join(',')}]}`;
  };
  return {
    persistClient: (client) => {
      if (suspended) return writing;
      const value = serialize(prepareForPersist(client, baseOf));
      return chain(() => (suspended ? Promise.resolve() : storage.set(cacheStorageKey, value)));
    },
    restoreClient: async () => {
      const raw = await storage.get(cacheStorageKey);
      if (!raw) return undefined;
      const stored = JSON.parse(raw) as StoredClient;
      if (!Array.isArray(stored.queries)) return undefined;
      const queries = stored.queries.map(({ q, d }) => ({ ...q, state: { ...q.state, data: d } }));
      return {
        timestamp: stored.timestamp,
        buster: stored.buster,
        clientState: { mutations: [], queries },
      } as unknown as PersistedClient;
    },
    removeClient: () => chain(() => storage.del(cacheStorageKey)),
    suspend: () => {
      suspended = true;
      return writing;
    },
  };
}
