import type { ListState } from '@rooster/core/reducers';
import type { DehydrateOptions, Query, QueryClient } from '@tanstack/react-query';
import type { PersistedClient, Persister } from '@tanstack/react-query-persist-client';
import { del, get, keys, set } from 'idb-keyval';

/** The single, account-less snapshot key of releases up to 1.3; migrated or dropped at boot. */
export const legacyCacheStorageKey = 'rooster-cache-v1';
const cacheKeyPrefix = `${legacyCacheStorageKey}:`;
/**
 * 04 §6.1: the IndexedDB key of an account's persisted query cache (ADR 0051/0056). Snapshots
 * are keyed by account, so no cross-tab timing can restore one account's cache for another:
 * a start reads only the browser owner's key, and cleanup deletes other accounts' keys, never
 * the one an account taking over writes.
 */
export const cacheStorageKey = (userId: string): string => `${cacheKeyPrefix}${userId}`;

const isSnapshotKey = (key: string) =>
  key === legacyCacheStorageKey || key.startsWith(cacheKeyPrefix);

/** The signed-in account the persisted cache and the outbox belong to (localStorage). */
const ownerKey = 'rooster.cacheOwner';

export function readCacheOwner(): string | null {
  try {
    return globalThis.localStorage?.getItem(ownerKey) ?? null;
  } catch {
    return null;
  }
}

export function writeCacheOwner(userId: string | null): void {
  try {
    if (userId) globalThis.localStorage?.setItem(ownerKey, userId);
    else globalThis.localStorage?.removeItem(ownerKey);
  } catch {
    // Storage blocked: the next start compares against nothing and restores nothing.
  }
}
/** 04 §6.1: older caches are discarded. */
export const cacheMaxAgeMs = 30 * 24 * 60 * 60 * 1000;
/**
 * A cache whose last server-confirmed `/me` is older than this is deleted instead of restored:
 * the session lifetime (30 days), so an offline device stops showing data its session could no
 * longer fetch.
 */
export const cacheConfirmMaxAgeMs = cacheMaxAgeMs;
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
  /** A fresh `/me` succeeded at `at` (ms epoch): stored with the next save. */
  confirmed(at: number): void;
  /** Deletes one account's snapshot (its session ended). Also once suspended. */
  removeFor(userId: string): Promise<void>;
  /**
   * An account's session ended (`true`) or was confirmed again (`false`): no snapshot of an
   * ended session is saved, whichever tab tries.
   */
  setExpired(userId: string, expired: boolean): void;
  /** Deletes every snapshot but `userId`'s (an account took over; null: all of them). */
  removeExcept(userId: string | null): Promise<void>;
  /**
   * At start: moves a snapshot of the old account-less key to the owner's key when it is the
   * owner's, then deletes every snapshot but the owner's.
   */
  tidy(owner: string | null): Promise<void>;
}

/** The stored shape: each query's data apart from its metadata (see `serialize`). */
interface StoredClient {
  timestamp: number;
  buster: string;
  /** The last server-confirmed `/me` (null: never; missing: written before 1.0.1). */
  confirmedAt?: number | null;
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
  keys(): Promise<string[]>;
}

const idbStorage: KeyValueStorage = {
  get: (key) => get<string>(key),
  set: (key, value) => set(key, value),
  del: (key) => del(key),
  keys: async () => (await keys()).filter((key): key is string => typeof key === 'string'),
};

/**
 * The IndexedDB persister (idb-keyval, one key per account: `cacheStorageKey`). Writes are
 * serialised; the sync engine throttles them with a timer it can cancel, so no delayed save
 * writes the previous user's data back after a sign-out. A snapshot is stored under the account
 * its `/me` names (none: not stored), and restored only for `owner`.
 */
export function createCachePersister(
  baseOf: (orgId: string) => ListState | undefined,
  storage: KeyValueStorage = idbStorage,
  now: () => number = Date.now,
  owner: () => string | null = readCacheOwner,
): CachePersister {
  let suspended = false;
  const expiredAccounts = new Set<string>();
  let confirmedAt: number | null = null;
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
    return `{"timestamp":${client.timestamp},"buster":${JSON.stringify(client.buster)},"confirmedAt":${JSON.stringify(confirmedAt)},"queries":[${queries.join(',')}]}`;
  };
  return {
    persistClient: (client) => {
      if (suspended) return writing;
      const account = accountOf(client.clientState.queries.find((q) => q.queryKey[0] === 'me'));
      if (account === undefined || expiredAccounts.has(account)) return writing;
      const value = serialize(prepareForPersist(client, baseOf));
      const key = cacheStorageKey(account);
      return chain(() => (suspended ? Promise.resolve() : storage.set(key, value)));
    },
    restoreClient: async () => {
      const account = owner();
      if (account === null) return undefined;
      const key = cacheStorageKey(account);
      const raw = await storage.get(key);
      if (!raw) return undefined;
      const stored = JSON.parse(raw) as StoredClient;
      if (!Array.isArray(stored.queries)) return undefined;
      const at = lastConfirmed(stored);
      if (at === null || now() - at > cacheConfirmMaxAgeMs) {
        await chain(() => storage.del(key));
        return undefined;
      }
      confirmedAt = Math.max(confirmedAt ?? 0, at);
      const queries = stored.queries.map(({ q, d }) => ({ ...q, state: { ...q.state, data: d } }));
      return {
        timestamp: stored.timestamp,
        buster: stored.buster,
        clientState: { mutations: [], queries },
      } as unknown as PersistedClient;
    },
    removeClient: () => {
      confirmedAt = null;
      return removeWhere(() => true);
    },
    suspend: () => {
      suspended = true;
      return writing;
    },
    confirmed: (at) => {
      confirmedAt = Math.max(confirmedAt ?? 0, at);
    },
    removeFor: (userId) => chain(() => storage.del(cacheStorageKey(userId))),
    setExpired: (userId, expired) => {
      if (expired) expiredAccounts.add(userId);
      else expiredAccounts.delete(userId);
    },
    removeExcept: (userId) => {
      const keep = userId === null ? null : cacheStorageKey(userId);
      return removeWhere((key) => key !== keep);
    },
    tidy: (account) => {
      // Fenced: housekeeping started for one owner stops as soon as another tab changed the
      // owner, so it never deletes what the account taking over has saved meanwhile.
      const current = () => owner() === account;
      return chain(async () => {
        if (!current()) return;
        const raw = await storage.get(legacyCacheStorageKey);
        if (raw !== undefined && account !== null && legacyOwner(raw) === account) {
          const key = cacheStorageKey(account);
          if (current() && (await storage.get(key)) === undefined) await storage.set(key, raw);
        }
      }).then(() =>
        removeWhere((key) => account === null || key !== cacheStorageKey(account), current),
      );
    },
  };

  /**
   * Deletes the snapshot keys `doomed` picks (the legacy key included), after earlier writes.
   * Never the snapshot of the browser's owner at the moment of each deletion (another tab may
   * have made someone else the owner meanwhile), and nothing more once `valid` turns false.
   */
  function removeWhere(
    doomed: (key: string) => boolean,
    valid: () => boolean = () => true,
  ): Promise<void> {
    return chain(async () => {
      for (const key of await storage.keys()) {
        if (!valid()) return;
        const current = owner();
        if (current !== null && key === cacheStorageKey(current)) continue;
        if (isSnapshotKey(key) && doomed(key)) await storage.del(key);
      }
    });
  }
}

/** The account a dehydrated `/me` query names. */
function accountOf(query: { state: { data?: unknown } } | undefined): string | undefined {
  const id = (query?.state.data as { user?: { id?: unknown } } | undefined)?.user?.id;
  return typeof id === 'string' ? id : undefined;
}

/** The account of a snapshot stored under the old account-less key (undefined: unreadable). */
function legacyOwner(raw: string): string | undefined {
  try {
    const stored = JSON.parse(raw) as StoredClient;
    return accountOf(
      stored.queries
        ?.filter(({ q }) => q.queryKey[0] === 'me')
        .map(({ d }) => ({ state: { data: d } }))[0],
    );
  } catch {
    return undefined;
  }
}

/**
 * When the stored cache was last confirmed by the server. Caches written before 1.0.1 have no
 * `confirmedAt`; for them the stored `/me` query's fetch time stands in.
 */
function lastConfirmed(stored: StoredClient): number | null {
  if (stored.confirmedAt !== undefined) return stored.confirmedAt;
  const me = stored.queries.find(({ q }) => q.queryKey[0] === 'me');
  const at = me?.q.state.dataUpdatedAt;
  return typeof at === 'number' && at > 0 ? at : null;
}
