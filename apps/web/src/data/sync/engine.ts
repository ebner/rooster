import { onlineManager, type QueryCacheNotifyEvent, type QueryClient } from '@tanstack/react-query';
import {
  persistQueryClientRestore,
  persistQueryClientSave,
} from '@tanstack/react-query-persist-client';
import { unsubscribeThisBrowser } from '../../features/pwa/push-local';
import { sweepUserStorage } from '../../lib/user-storage';
import { useSyncStore } from '../../state/sync-store';
import { ApiError } from '../errors';
import { getClientId, registerListPipeline } from '../list';
import { httpTransport } from '../pipeline/http-transport';
import { ListPipeline, myListKey, tagsKey } from '../pipeline/pipeline';
import type { ListTransport } from '../pipeline/transport';
import { closeSessionForGood, sessionDataCleared } from '../session-events';
import type { Me } from '../types';
import { buildInfo, cacheBuster } from './build-info';
import { createSyncChannel, type SyncChannel, type SyncMessage } from './channel';
import { type EventSourceFactory, EventStream, serverIsNewer } from './events';
import { electLeader, type Leadership } from './leader';
import {
  createIdbOutbox,
  createMemoryOutbox,
  hasIndexedDb,
  type Outbox,
  type OutboxRecord,
} from './outbox';
import {
  type CachePersister,
  cacheMaxAgeMs,
  cacheSaveDebounceMs,
  cacheSaveMaxWaitMs,
  createCachePersister,
  keepPersistedQueries,
  persistDehydrateOptions,
  restoredBases,
} from './persist';

/** 04 §6.2: the outbox is retried at least this often while ops are queued. */
export const flushIntervalMs = 30_000;
/**
 * A visible follower whose queue saw no sign of the leader for this long asks it whether it is
 * alive (`ping`)...
 */
export const leaderStallMs = 2_000;
/** ...and takes the lock when no answer came within this long (a frozen or hung leader). */
export const leaderAnswerMs = 2_000;
/** After the leader answered, the follower looks again this much later. */
const leaderRecheckMs = 15_000;
/** Cold start waits at most this long for IndexedDB before rendering without the cache. */
const restoreTimeoutMs = 3_000;
/** The signed-in user the persisted cache and outbox belong to. */
const ownerKey = 'rooster.cacheOwner';

export interface SyncEngineOptions {
  queryClient: QueryClient;
  transport?: ListTransport;
  outbox?: Outbox;
  channel?: SyncChannel;
  persister?: CachePersister;
  eventSource?: EventSourceFactory;
  /** Web Locks (tests pass a fake or `undefined` for the fallback). */
  locks?: Parameters<typeof electLeader>[1] | null;
  /** Test seam: skip `window`/`document` listeners. */
  listen?: boolean;
  /**
   * Whether every tab reads and writes this same outbox (IndexedDB), so a tab can correct its
   * mirrored queue against it. Default: true for IndexedDB and for an injected outbox.
   */
  sharedOutbox?: boolean;
  /** Test seam: the leader watch's timings (default `leaderStallMs`, `leaderAnswerMs`). */
  leaderWatch?: { stallMs?: number; answerMs?: number; recheckMs?: number };
}

export interface SyncEngine {
  pipeline: ListPipeline;
  /** "Sync problem · Retry" and pull-to-refresh: try the outbox now. */
  syncNow(): void;
  /** Sign-out: forget every local copy (cache, outbox) in every tab. */
  clear(options?: { final?: boolean }): Promise<void>;
  /**
   * What to do when the SSE `hello` reports a newer server (set by the PWA module); runs at
   * once if one already did.
   */
  setUpdateCheck(check: () => void): void;
  stop(): void;
}

let current: SyncEngine | null = null;

/** The running engine (null before `startSync` and in tests). */
export function syncEngine(): SyncEngine | null {
  return current;
}

/**
 * Signs out locally: clears cache, outbox and per-user localStorage here and in the other tabs
 * (04 §6.1).
 */
export async function clearLocalData(): Promise<void> {
  sweepUserStorage();
  await current?.clear({ final: true });
}

/** Once per tab and account: a page whose stored data cannot be dropped must not reload forever. */
const reloadedKey = 'rooster.reloadedAs';

function reloadedAs(userId: string): boolean {
  try {
    return globalThis.sessionStorage?.getItem(reloadedKey) === userId;
  } catch {
    return false;
  }
}

function markReloadedAs(userId: string): void {
  try {
    globalThis.sessionStorage?.setItem(reloadedKey, userId);
  } catch {
    // Without session storage a second switch to the same account just wipes in place.
  }
}

function readOwner(): string | null {
  try {
    return globalThis.localStorage?.getItem(ownerKey) ?? null;
  } catch {
    return null;
  }
}

function writeOwner(userId: string | null): void {
  try {
    if (userId) globalThis.localStorage?.setItem(ownerKey, userId);
    else globalThis.localStorage?.removeItem(ownerKey);
  } catch {
    // Storage blocked: the next start compares against nothing and keeps the cache.
  }
}

/** Records from before 1.0.1 carry no user: they belong to the owner of the restored cache. */
function withOwner(records: readonly OutboxRecord[]): OutboxRecord[] {
  const owner = readOwner();
  return records.map((r) =>
    r.userId !== undefined || owner === null ? r : { ...r, userId: owner },
  );
}

/** Query roots keyed `[root, orgId, …]` (`search`: an org id or `all`), and task details. */
const orgScopedRoots: ReadonlySet<unknown> = new Set([
  'my-list',
  'tags',
  'task',
  'trash',
  'search',
  'org-members',
  'org-invites',
]);

/** Org-scoped query keys are `[root, orgId, …]`; task details carry their org in the data. */
function orgOfQuery(queryKey: readonly unknown[], data: unknown): string | undefined {
  if (queryKey[0] === 'task') {
    const orgId = (data as { orgId?: unknown } | undefined)?.orgId;
    return typeof orgId === 'string' ? orgId : undefined;
  }
  return typeof queryKey[1] === 'string' ? queryKey[1] : undefined;
}

function pageVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

function withTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), restoreTimeoutMs)),
  ]);
}

/**
 * Boots offline and sync (04 §6): restores the persisted cache and the outbox before the
 * first render, installs the outbox-backed pipeline, elects the flushing tab, wires the
 * flush triggers and, once the user is known, the SSE stream.
 */
export async function startSync(options: SyncEngineOptions): Promise<SyncEngine> {
  const { queryClient } = options;
  const transport = options.transport ?? httpTransport;
  const listen = options.listen ?? typeof window !== 'undefined';
  const startedAt = Date.now();
  const online = () => globalThis.navigator?.onLine ?? true;
  onlineManager.setOnline(online());
  useSyncStore.setState({ online: online() });

  const stallMs = options.leaderWatch?.stallMs ?? leaderStallMs;
  const answerMs = options.leaderWatch?.answerMs ?? leaderAnswerMs;
  const recheckMs = options.leaderWatch?.recheckMs ?? leaderRecheckMs;
  const sharedOutbox = options.sharedOutbox ?? (options.outbox !== undefined || hasIndexedDb());
  const outbox = options.outbox ?? (hasIndexedDb() ? createIdbOutbox() : createMemoryOutbox());
  const channel = options.channel ?? createSyncChannel();
  // Listen before the restore below: a confirmation posted meanwhile would otherwise be lost,
  // leaving its op queued (and "Syncing…" up) here for good.
  const early: SyncMessage[] = [];
  let onMessage: ((message: SyncMessage) => void) | null = null;
  const unlistenChannel = channel.listen((message) => {
    if (onMessage) onMessage(message);
    else early.push(message);
  });
  const clientId = getClientId();
  /** Set once a fresh `/me` confirmed who is signed in: only then may ops be sent. */
  let userId: string | null = null;
  /** The account this document has run as; unlike `userId` it survives a lost session. */
  let ranAs: string | null = null;
  let leadership: Leadership | null = null;

  const pipeline = new ListPipeline({
    transport,
    queryClient,
    clientId,
    outbox,
    channel,
    isLeader: () => leadership?.isLeader() ?? false,
    canSend: () => userId !== null,
    isOnline: online,
    afterPaint,
    user: () => userId ?? readOwner(),
  });
  registerListPipeline(queryClient, transport, pipeline);

  // Reads (04 §6.1): the cache renders immediately, then revalidates.
  keepPersistedQueries(queryClient);
  const persister = options.persister ?? createCachePersister((org) => pipeline.baseOf(org));
  const restoreOptions = { queryClient, persister, buster: cacheBuster, maxAge: cacheMaxAgeMs };
  await withTimeout(persistQueryClientRestore(restoreOptions), undefined);
  const records = withOwner(await withTimeout(outbox.load(), []));
  pipeline.restore(restoredBases(queryClient), records);
  // The restored data renders before a fresh `/me`: this page has run as that account too.
  ranAs = (queryClient.getQueryData<Me>(['me']) as Me | undefined)?.user?.id ?? null;
  // Restored data renders now but is never trusted as fresh: every query refetches on mount
  // (when online), whatever its staleTime. This is also what notices a revoked session.
  void queryClient.invalidateQueries({ refetchType: 'none' });

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let saving = true;
  const save = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    if (!saving) return Promise.resolve();
    return persistQueryClientSave({
      queryClient,
      persister,
      buster: cacheBuster,
      dehydrateOptions: persistDehydrateOptions,
    });
  };
  let dirtySince = 0;
  const saveWhenIdle = () => {
    saveTimer = null;
    const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o?: object) => number })
      .requestIdleCallback;
    if (idle) idle(() => void save(), { timeout: 5_000 });
    else void save();
  };
  /** Debounced while edits keep coming, capped by the max wait (see `cacheSaveDebounceMs`). */
  const scheduleSave = () => {
    if (!saving) return;
    const now = Date.now();
    if (saveTimer === null) dirtySince = now;
    else if (now - dirtySince >= cacheSaveMaxWaitMs) return;
    else clearTimeout(saveTimer);
    saveTimer = setTimeout(saveWhenIdle, cacheSaveDebounceMs);
  };
  const unsubscribeCache = queryClient.getQueryCache().subscribe((event) => {
    if (event.type === 'added' || event.type === 'removed' || event.type === 'updated') {
      scheduleSave();
    }
    onMeEvent(event);
  });
  // A confirmation can change the stored base without changing the rendered view.
  const unsubscribePipeline = pipeline.subscribe(scheduleSave);

  /** The outbox is the truth every tab shares: catch up with it (missed messages). */
  const readOutbox = (): Promise<void> => {
    const load = () => outbox.load().then(withOwner);
    if (sharedOutbox) return pipeline.syncWithOutbox(load).catch(() => {});
    return load()
      .then((stored) => pipeline.restore(new Map(), stored))
      .catch(() => {});
  };

  /** When this follower last heard from the leader (its messages, or an answer to `ping`). */
  let leaderSeenAt = 0;
  /*
   * The leader watch (ADR 0010 amendment): the lock holder may be frozen. Android freezes a
   * backgrounded tab or installed PWA without releasing its Web Locks, so the instance in front
   * would mirror its ops forever ("Syncing…") and never send them. A visible follower with
   * queued ops that hears nothing from the leader pings it, and takes the lock when no answer
   * comes. Hidden tabs never take over: they may be frozen next.
   */
  let watchTimer: ReturnType<typeof setTimeout> | null = null;
  /** A ping is out: its answer decides, nothing reschedules the watch meanwhile. */
  let pinging = false;
  const mayTakeOver = () =>
    leadership !== null &&
    !leadership.isLeader() &&
    userId !== null &&
    pipeline.pending > 0 &&
    online() &&
    pageVisible();
  function stopWatching() {
    if (watchTimer) clearTimeout(watchTimer);
    watchTimer = null;
    pinging = false;
  }
  /**
   * Looks at the leader after `delay`, unless a look is already planned. With 0 (foreground,
   * "Retry") it asks at once, replacing a later look.
   */
  function watchLeader(delay: number) {
    if (pinging || !mayTakeOver()) return;
    if (watchTimer !== null) {
      if (delay > 0) return;
      clearTimeout(watchTimer);
    }
    const since = Date.now();
    watchTimer = setTimeout(() => {
      watchTimer = null;
      if (!mayTakeOver()) return;
      // The leader is getting on with it: look again later.
      if (delay > 0 && leaderSeenAt >= since) watchLeader(stallMs);
      else pingLeader();
    }, delay);
  }
  function pingLeader() {
    const askedAt = Date.now();
    pinging = true;
    channel.post({ type: 'ping' });
    watchTimer = setTimeout(() => {
      watchTimer = null;
      pinging = false;
      if (!mayTakeOver()) return;
      if (leaderSeenAt >= askedAt) {
        // Alive. What is stale may be this tab's mirror (a confirmation it missed).
        watchLeader(recheckMs);
        void readOutbox();
        return;
      }
      leadership?.steal();
    }, answerMs);
  }
  // Leader election (04 §6.2). A new leader re-reads the outbox: the previous one may have
  // closed with ops it had not announced yet, or confirmed some this tab never heard of.
  leadership = electLeader(
    {
      onLeader: () => {
        stopWatching();
        useSyncStore.setState({ leader: true });
        void readOutbox().finally(() => pipeline.resume());
      },
      onLost: () => {
        useSyncStore.setState({ leader: false, syncing: false });
        watchLeader(stallMs);
      },
    },
    options.locks === null ? undefined : (options.locks ?? undefined),
  );

  onMessage = (message) => {
    switch (message.type) {
      case 'cleared':
        void onClearedElsewhere();
        return;
      case 'status':
      case 'applied':
      case 'dropped':
      case 'remap':
        leaderSeenAt = Date.now();
        break;
      case 'ping':
        // The asking tab may know ops this one missed; reading the outbox picks them up.
        if (leadership?.isLeader()) void readOutbox().finally(() => pipeline.resume());
        break;
      default:
        break;
    }
    pipeline.receive(message);
  };
  for (const message of early.splice(0)) onMessage(message);

  const unsubscribeWatch = pipeline.subscribe(() => watchLeader(stallMs));

  let updateCheck: () => void = () => {};
  // A `hello` may arrive before the PWA module has set the check: it runs once that happens.
  let serverNewer = false;
  let firstOpen = true;
  const events = new EventStream({
    clientId,
    ...(options.eventSource ? { factory: options.eventSource } : {}),
    invalidate: (key) => void queryClient.invalidateQueries({ queryKey: [...key] }),
    onConnect: () => {
      // The very first open right after start follows fresh fetches; later ones may have
      // missed events (there is no replay log): refetch everything active.
      const skip = firstOpen && Date.now() - startedAt < 5_000;
      firstOpen = false;
      if (!skip) void queryClient.invalidateQueries();
      pipeline.retryNow();
    },
    onHello: (hello) => {
      if (!serverIsNewer(hello, buildInfo)) return;
      serverNewer = true;
      updateCheck();
    },
    onState: (sseState) => useSyncStore.setState({ sseState }),
  });

  /**
   * Synchronously, before anything awaits: nothing of the session that ends may send another
   * request (the next one would carry another account's cookies) or reach its caches.
   */
  function closeSession() {
    // Every request is refused from here on, whatever path it takes (ADR 0051).
    closeSessionForGood();
    userId = null;
    pipeline.reset();
    queryClient.getMutationCache().clear();
    // No more saves, SSE, channel messages (a ping would reconcile the shared outbox with the
    // old account's view) or leadership: the page is only waiting to unload.
    engine.stop();
  }

  let started = false;
  function onUser(me: Me) {
    const owner = readOwner();
    if (ranAs !== null && ranAs !== me.user.id && !reloadedAs(me.user.id)) {
      // This page ran as another account (signed in elsewhere in this browser, or restored
      // from its cache). Its continuations (pending requests, revealed secrets, undo, drafts,
      // consent) belong to that account: close the session at once, then start over as the
      // new one. The tab that signed in has normally wiped the shared outbox and cache
      // already (below); wiping again here could drop ops the new account has queued since.
      closeSession();
      const takeOver = async () => {
        if (owner && owner !== me.user.id) {
          // Before the owner changes: a reload must not leave the old account's push behind.
          await unsubscribeThisBrowser();
          sweepUserStorage(me.user.id);
          writeOwner(me.user.id);
          await wipe({ keepMe: false });
          channel.post({ type: 'cleared' });
        }
        await persister.suspend();
      };
      void takeOver()
        .catch(() => {})
        .finally(() => {
          markReloadedAs(me.user.id);
          globalThis.location?.reload();
        });
      return;
    }
    if (owner && owner !== me.user.id) {
      // Another account on this browser: nothing of the previous one may leak or be sent. A
      // push subscription here is not this user's (their marker would have been swept), even
      // one whose registration was still under way when the account changed.
      void unsubscribeThisBrowser();
      void wipe({ keepMe: true }).then(() => channel.post({ type: 'cleared' }));
    }
    ranAs = me.user.id;
    sweepUserStorage(me.user.id);
    writeOwner(me.user.id);
    userId = me.user.id;
    saving = true;
    pipeline.retainUser();
    pruneOrgs(me);
    pipeline.resume();
    watchLeader(stallMs);
    if (started) return;
    started = true;
    void requestPersistentStorage();
    prefetchOrgs(me);
    events.start();
  }

  /**
   * An online 401 on `/me` (signed out, revoked, disabled): the cached data of that session
   * goes, in memory and on disk, before the route guard sends the browser to /login. The
   * outbox stays, owned by the user id: it flushes after that user signs in again, and is
   * wiped if someone else does.
   */
  function onSessionEnded() {
    userId = null;
    saving = false;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    events.stop();
    started = false;
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    sessionDataCleared();
    sweepUserStorage();
    // The cached profile must not count as signed in either (the /login guard reads it); its
    // refetch answers 401 again, which the route guard turns into /login?redirect=….
    void queryClient.resetQueries({ queryKey: ['me'] }).catch(() => {});
    void persister.removeClient();
  }

  function onMeEvent(event: QueryCacheNotifyEvent) {
    if (event.type !== 'updated' || event.query.queryKey[0] !== 'me') return;
    const { data, dataUpdatedAt, status, error } = event.query.state;
    if (status === 'error' && error instanceof ApiError && error.status === 401) {
      if (userId !== null || saving) onSessionEnded();
      return;
    }
    // A restored `/me` may be another session's: wait for a fresh one.
    if (status !== 'success' || !data || dataUpdatedAt < startedAt) return;
    const me = data as Me;
    if (userId === me.user.id) pruneOrgs(me);
    else onUser(me);
    // Only a response from the server confirms the session, not an optimistic `setQueryData`
    // (no action: the `/me` fetched while the cache was restoring).
    const action = event.action as typeof event.action | undefined;
    if (action === undefined || (action.type === 'success' && !action.manual)) {
      persister.confirmed(dataUpdatedAt);
    }
  }

  /**
   * Membership revoked (04 §4.3): whatever is cached for an org no longer in `/me` (its list,
   * tags, task details, trash, searches, queued ops) goes, in memory and with the next save on
   * disk.
   */
  function pruneOrgs(me: Me) {
    const allowed = new Set(me.orgs.map((org) => org.id));
    const revoked = new Set<string>();
    queryClient.removeQueries({
      predicate: (query) => {
        const [root] = query.queryKey;
        if (root === 'me') return false;
        if (root === 'search' && query.queryKey[1] === 'all') {
          const hits = query.state.data as readonly { orgId?: unknown }[] | undefined;
          return (
            hits?.some((hit) => typeof hit.orgId === 'string' && !allowed.has(hit.orgId)) ?? false
          );
        }
        if (!orgScopedRoots.has(root)) return false;
        const orgId = orgOfQuery(query.queryKey, query.state.data);
        if (orgId === undefined || allowed.has(orgId)) return false;
        revoked.add(orgId);
        return true;
      },
    });
    for (const orgId of pipeline.orgIds()) if (!allowed.has(orgId)) revoked.add(orgId);
    if (revoked.size > 0) pipeline.forgetOrgs(revoked);
  }

  /** FR-PWA-2: every org's My tasks and tags are readable offline, not only visited ones. */
  function prefetchOrgs(me: Me) {
    const run = () => {
      // The orgs of the `/me` current when this runs: a membership may have gone meanwhile.
      const orgs = queryClient.getQueryData<Me>(['me'])?.orgs ?? me.orgs;
      for (const org of orgs) {
        void queryClient.prefetchQuery({
          queryKey: myListKey(org.id),
          queryFn: () => pipeline.fetch(org.id),
          staleTime: 30_000,
        });
        void queryClient.prefetchQuery({
          queryKey: tagsKey(org.id),
          queryFn: () => transport.fetchTags(org.id),
          staleTime: 60_000,
        });
      }
    };
    const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o?: object) => number })
      .requestIdleCallback;
    if (idle) idle(run, { timeout: 3_000 });
    else setTimeout(run, 500);
  }

  async function wipe({ keepMe }: { keepMe: boolean }) {
    sessionDataCleared();
    pipeline.reset();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    queryClient.removeQueries({ predicate: (q) => !keepMe || q.queryKey[0] !== 'me' });
    await Promise.all([outbox.clear().catch(() => {}), persister.removeClient()]);
  }

  async function onClearedElsewhere() {
    // Before the first await: nothing of this session may go on with the next one's cookies.
    closeSession();
    await persister.suspend();
    queryClient.clear();
    // Signed out, or someone else signed in, in another tab: start over as whoever it is now.
    globalThis.location?.reload();
  }

  // Flush triggers (04 §6.2): online, foreground, the 30 s timer; SSE (re)connect above.
  const onOnline = () => {
    useSyncStore.setState({ online: true });
    pipeline.retryNow();
    events.reconnectNow();
    watchLeader(stallMs);
  };
  const onOffline = () => useSyncStore.setState({ online: false });
  const onVisibility = () => {
    const hidden = document.visibilityState === 'hidden';
    events.visibilityChanged(hidden);
    if (hidden) void save();
    else {
      pipeline.retryNow();
      watchLeader(0);
    }
  };
  const onPageHide = () => void save();
  const interval = setInterval(() => {
    if (pipeline.pending === 0) return;
    pipeline.resume();
    watchLeader(stallMs);
  }, flushIntervalMs);
  if (listen) {
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);
  }

  // A `/me` already fetched during the restore wait.
  const me = queryClient.getQueryCache().find({ queryKey: ['me'] });
  if (me) onMeEvent({ type: 'updated', query: me } as QueryCacheNotifyEvent);

  const engine: SyncEngine = {
    pipeline,
    syncNow: () => {
      pipeline.retryNow();
      events.reconnectNow();
      watchLeader(0);
    },
    clear: async ({ final = false } = {}) => {
      if (final) {
        saving = false;
        events.stop();
        writeOwner(null);
      }
      await wipe({ keepMe: !final });
      if (final) await persister.suspend();
      channel.post({ type: 'cleared' });
    },
    setUpdateCheck: (check) => {
      updateCheck = check;
      if (serverNewer) check();
    },
    stop: () => {
      saving = false;
      if (saveTimer) clearTimeout(saveTimer);
      clearInterval(interval);
      stopWatching();
      events.stop();
      unsubscribeCache();
      unsubscribePipeline();
      unsubscribeWatch();
      unlistenChannel();
      leadership?.release();
      if (listen) {
        window.removeEventListener('online', onOnline);
        window.removeEventListener('offline', onOffline);
        window.removeEventListener('pagehide', onPageHide);
        document.removeEventListener('visibilitychange', onVisibility);
      }
      if (current === engine) current = null;
    },
  };
  current = engine;
  return engine;
}

/**
 * The frame showing an optimistic change has been painted. Capped at 100 ms: a page hidden
 * right after the keypress paints nothing, and its op must still reach the outbox.
 */
function afterPaint(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function' || document.visibilityState === 'hidden') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const cap = setTimeout(resolve, 100);
    requestAnimationFrame(() =>
      setTimeout(() => {
        clearTimeout(cap);
        resolve();
      }, 0),
    );
  });
}

/** 04 §6.1: ask the browser not to evict the cache and outbox under storage pressure. */
async function requestPersistentStorage(): Promise<void> {
  const storage = globalThis.navigator?.storage;
  try {
    if (!storage?.persist || (await storage.persisted?.())) return;
    await storage.persist();
  } catch {
    // Not granted or not supported: the data is still kept, just evictable.
  }
}
