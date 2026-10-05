import { uuidv7 } from '@rooster/core/ids';
import {
  applyOp,
  type ListOp,
  type ListOpSpec,
  type ListState,
  mergeDetailResponse,
  mergeResponse,
  normalizeMyList,
  type ReducerContext,
} from '@rooster/core/reducers';
import type { Task, TaskDetail } from '@rooster/core/schemas';
import type { QueryClient } from '@tanstack/react-query';
import { useSyncStore } from '../../state/sync-store';
import type { ApiError } from '../errors';
import { classifyFailure, type ListTransport, RateLimitedError } from './transport';

/** 02 §14: 1, 2, 4, 8, 16, 30 s, capped. */
export const backoffScheduleMs = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

export const myListKey = (orgId: string) => ['my-list', orgId] as const;
/** `['task', id]` (04 §5.1): GET /tasks/:id. */
export const taskDetailKey = (taskId: string) => ['task', taskId] as const;
/** `['tags', orgId]` (04 §5.1): GET /orgs/:orgId/tags. */
export const tagsKey = (orgId: string) => ['tags', orgId] as const;

interface Queued {
  op: ListOp;
  orgId: string;
  ctx: ReducerContext;
}

export interface PipelineOptions {
  transport: ListTransport;
  queryClient: QueryClient;
  /** Stable per browser profile (X-Rooster-Client-Id). */
  clientId: string;
  now?: () => number;
  backoffMs?: (failures: number) => number;
}

export interface DroppedOp {
  op: ListOp;
  error: ApiError;
  /** The view before the revert, for the toast ("Couldn't save 'title'"). */
  before: ListState | undefined;
}

type DropListener = (dropped: DroppedOp) => void;

/** Field equality for two copies of a task. */
function sameTask(a: Task, b: Task): boolean {
  return a === b || deepEqual(a, b);
}

/**
 * Equality ignoring what only the server stamps (`seq`, `createdAt`, `updatedAt`): rows never
 * show them, so a confirmation that differs only there needs no render now.
 */
function sameTaskButStamps(a: Task, b: Task): boolean {
  if (a === b) return true;
  const { updatedAt: _ua, createdAt: _ca, seq: _sa, ...restA } = a;
  const { updatedAt: _ub, createdAt: _cb, seq: _sb, ...restB } = b;
  return deepEqual(restA, restB);
}

/** Structural equality of JSON-like values, independent of key order. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

function sameRecord<T>(
  a: Readonly<Record<string, T>>,
  b: Readonly<Record<string, T>>,
  equal: (x: T, y: T) => boolean,
): boolean {
  if (a === b) return true;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    const x = a[key];
    const y = b[key];
    if (x === y) continue;
    if (x === undefined || y === undefined || !equal(x, y)) return false;
  }
  return true;
}

const sameJson = <T>(x: T, y: T) => deepEqual(x, y);

/**
 * Whether two list states are equal (identity first, then fields of the few that differ).
 * With `ignoreStamps`, server-only stamps on tasks do not count.
 */
export function equivalentStates(a: ListState, b: ListState, ignoreStamps = false): boolean {
  return (
    sameRecord(a.tasks, b.tasks, ignoreStamps ? sameTaskButStamps : sameTask) &&
    sameRecord(a.groups, b.groups, sameJson) &&
    sameRecord(a.deletedTasks, b.deletedTasks, sameJson) &&
    sameRecord(a.deletedGroups, b.deletedGroups, sameJson) &&
    a.expandedTaskIds.join() === b.expandedTaskIds.join()
  );
}

/**
 * The mutation pipeline (04 §6.2), Phase 2 edition: an in-memory FIFO queue (the IndexedDB
 * outbox replaces it in P4 with the same op shape).
 *
 * Every op is applied optimistically to the `['my-list', orgId]` query cache in the same
 * tick, then sent sequentially. The pipeline keeps the last server-confirmed state per org
 * (`base`); the cache is always `base` plus the pending ops replayed on top, so a server
 * response or a refetch never clobbers a newer optimistic change.
 */
export class ListPipeline {
  readonly transport: ListTransport;
  private readonly queryClient: QueryClient;
  private readonly clientId: string;
  private readonly now: () => number;
  private readonly backoffMs: (failures: number) => number;
  private readonly bases = new Map<string, ListState>();
  private readonly queue: Queued[] = [];
  /** Ops confirmed recently, replayed over snapshots fetched while they were in flight. */
  private readonly confirmed: { seq: number; item: Queued }[] = [];
  private confirmSeq = 0;
  private flushing = false;
  private paused = false;
  private failures = 0;
  private wake: (() => void) | null = null;
  private readonly dropListeners = new Set<DropListener>();
  private readonly changeListeners = new Set<() => void>();
  private version = 0;
  private idleWaiters: (() => void)[] = [];

  constructor(options: PipelineOptions) {
    this.transport = options.transport;
    this.queryClient = options.queryClient;
    this.clientId = options.clientId;
    this.now = options.now ?? Date.now;
    this.backoffMs =
      options.backoffMs ??
      ((n) => backoffScheduleMs[Math.min(n, backoffScheduleMs.length) - 1] ?? 30_000);
  }

  /** The query function for `['my-list', orgId]`: fetch, rebase, replay pending ops. */
  async fetch(orgId: string): Promise<ListState> {
    const seqAtStart = this.confirmSeq;
    const list = await this.transport.fetchMyList(orgId);
    const previous = this.view(orgId) ?? this.bases.get(orgId);
    let base = normalizeMyList(orgId, list, previous);
    for (const { seq, item } of this.confirmed) {
      if (seq > seqAtStart && item.orgId === orgId) base = this.apply(base, item);
    }
    this.bases.set(orgId, base);
    return this.replay(orgId);
  }

  /** The current optimistic state (what the list renders). */
  view(orgId: string): ListState | undefined {
    return this.queryClient.getQueryData<ListState>(myListKey(orgId));
  }

  /** Seeds the confirmed state directly (tests, fixtures). */
  seed(orgId: string, state: ListState): void {
    this.bases.set(orgId, state);
    this.queryClient.setQueryData(myListKey(orgId), this.replay(orgId));
  }

  get pending(): number {
    return this.queue.length;
  }

  /**
   * Ops not yet confirmed for an org, oldest first. Caches outside the list (`['task', id]`,
   * `['tags', orgId]`) render their server state with these replayed on top.
   */
  pendingOps(orgId: string): ListOp[] {
    return this.queue.filter((item) => item.orgId === orgId).map((item) => item.op);
  }

  /** Changes whenever the queue changes (for `useSyncExternalStore`). */
  getVersion = (): number => this.version;

  subscribe = (listener: () => void): (() => void) => {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  };

  /**
   * Stamps, applies and queues ops. The cache update is synchronous, so the UI renders the
   * change in the same frame (02 §1.3). Returns the stamped ops.
   */
  enqueue(orgId: string, specs: readonly ListOpSpec[], ctx: ReducerContext): ListOp[] {
    let view = this.view(orgId) ?? this.bases.get(orgId);
    if (!view) throw new Error(`ListPipeline: no state for org ${orgId}`);
    const ops: ListOp[] = [];
    for (const spec of specs) {
      const op = { ...spec, opId: uuidv7(), editTime: this.now(), clientId: this.clientId };
      const item = { op, orgId, ctx };
      view = this.apply(view, item);
      this.queue.push(item);
      ops.push(op);
    }
    this.queryClient.setQueryData(myListKey(orgId), view);
    this.publish();
    this.changed();
    void this.flush();
    return ops;
  }

  onDropped(listener: DropListener): () => void {
    this.dropListeners.add(listener);
    return () => this.dropListeners.delete(listener);
  }

  /** "Sync problem · Retry", reconnects and sign-in: try the head op now. */
  retryNow(): void {
    this.paused = false;
    this.wake?.();
    void this.flush();
  }

  /** Resolves once the queue is empty (tests, and P4's SW update gate). */
  idle(): Promise<void> {
    if (this.queue.length === 0 && !this.flushing) {
      this.flushLazySyncs();
      return Promise.resolve();
    }
    return new Promise((resolve) =>
      this.idleWaiters.push(() => {
        this.flushLazySyncs();
        resolve();
      }),
    );
  }

  private apply(state: ListState, { op, ctx }: Queued): ListState {
    return applyOp(state, op, { ...ctx, now: op.editTime });
  }

  private replay(orgId: string): ListState {
    let state = this.bases.get(orgId) as ListState;
    for (const item of this.queue) {
      if (item.orgId === orgId) state = this.apply(state, item);
    }
    return state;
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.paused) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0 && !this.paused) {
        const head = this.queue[0] as Queued;
        try {
          const response = await this.transport.send(head.op, head.orgId);
          this.queue.shift();
          this.failures = 0;
          this.confirm(head, response);
        } catch (error) {
          await this.fail(head, error);
        }
        this.publish();
        this.changed();
      }
    } finally {
      this.flushing = false;
      this.publish();
      if (this.queue.length === 0) {
        for (const resolve of this.idleWaiters.splice(0)) resolve();
      }
    }
  }

  private confirm(item: Queued, response: unknown): void {
    const base = this.bases.get(item.orgId);
    if (!base) return;
    const merged = mergeResponse(this.apply(base, item), item.op, response);
    this.bases.set(item.orgId, merged.state);
    this.confirmSeq += 1;
    this.confirmed.push({ seq: this.confirmSeq, item });
    if (this.confirmed.length > 100) this.confirmed.shift();
    // The server usually agrees with the optimistic guess. Then the rendered state stays, so a
    // confirmation costs no render while the user types (AC-2.12); server-only stamps (a new
    // task's `seq`) reach the cache when the browser is idle.
    const next = this.replay(item.orgId);
    const view = this.view(item.orgId);
    if (!view || !equivalentStates(view, next, true)) {
      this.queryClient.setQueryData(myListKey(item.orgId), next);
    } else if (!equivalentStates(view, next)) {
      this.syncWhenIdle(item.orgId);
    }
    if (merged.refetch) void this.refetch(item.orgId);
    this.confirmDetails(item, response);
    const { op } = item;
    const newTags = op.kind === 'task.create' && (op.payload.tagNames?.length ?? 0) > 0;
    if (op.kind === 'tag.create' || newTags) {
      void this.queryClient.invalidateQueries({ queryKey: tagsKey(item.orgId) });
    }
  }

  /** Confirmed ops move into every cached task detail they touch (their new server state). */
  private confirmDetails({ op, ctx }: Queued, response: unknown): void {
    const applyCtx = { ...ctx, now: op.editTime };
    for (const [key, detail] of this.queryClient.getQueriesData<TaskDetail>({
      queryKey: ['task'],
    })) {
      if (!detail) continue;
      const next = mergeDetailResponse(detail, op, response, applyCtx);
      if (next !== detail) this.queryClient.setQueryData(key, next);
    }
  }

  private readonly lazySyncs = new Map<string, () => void>();

  /** Writes base + pending ops to the cache once the browser is idle (or on `idle()`). */
  private syncWhenIdle(orgId: string): void {
    if (this.lazySyncs.has(orgId)) return;
    const run = () => {
      if (this.lazySyncs.get(orgId) !== run) return;
      this.lazySyncs.delete(orgId);
      if (this.bases.has(orgId)) {
        this.queryClient.setQueryData(myListKey(orgId), this.replay(orgId));
      }
    };
    this.lazySyncs.set(orgId, run);
    const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o?: object) => number })
      .requestIdleCallback;
    if (idle) idle(run, { timeout: 2_000 });
    else setTimeout(run, 200);
  }

  private flushLazySyncs(): void {
    for (const run of [...this.lazySyncs.values()]) run();
  }

  private changed(): void {
    this.version += 1;
    for (const listener of this.changeListeners) listener();
  }

  private async fail(item: Queued, error: unknown): Promise<void> {
    switch (classifyFailure(error)) {
      case 'drop': {
        // 403/404/409/410/422: never going to succeed. Revert (the op leaves the replay) and
        // refetch the affected list; the UI explains why.
        const before = this.view(item.orgId);
        this.queue.shift();
        this.failures = 0;
        this.queryClient.setQueryData(myListKey(item.orgId), this.replay(item.orgId));
        void this.refetch(item.orgId);
        void this.queryClient.invalidateQueries({ queryKey: ['task'] });
        void this.queryClient.invalidateQueries({ queryKey: tagsKey(item.orgId) });
        for (const listener of this.dropListeners) {
          listener({ op: item.op, error: error as ApiError, before });
        }
        return;
      }
      case 'auth':
        this.paused = true;
        useSyncStore.setState({ sessionExpired: true });
        return;
      case 'rate':
        await this.sleep(error instanceof RateLimitedError ? error.retryAfterMs : 5_000);
        return;
      case 'transient':
        this.failures += 1;
        await this.sleep(this.backoffMs(this.failures));
        return;
    }
  }

  private refetch(orgId: string): Promise<void> {
    return this.queryClient.invalidateQueries({ queryKey: myListKey(orgId) });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(timer);
        self.wake = null;
        resolve();
      }
      this.wake = done;
    });
  }

  private publish(): void {
    useSyncStore.setState({
      pending: this.queue.length,
      failures: this.failures,
      ...(this.paused ? {} : { sessionExpired: false }),
    });
  }
}
