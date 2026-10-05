import { uuidv7 } from '@rooster/core/ids';
import {
  applyOp,
  type ListOp,
  type ListOpSpec,
  type ListState,
  mergeResponse,
  normalizeMyList,
  type ReducerContext,
} from '@rooster/core/reducers';
import type { QueryClient } from '@tanstack/react-query';
import { useSyncStore } from '../../state/sync-store';
import type { ApiError } from '../errors';
import { classifyFailure, type ListTransport, RateLimitedError } from './transport';

/** 02 §14: 1, 2, 4, 8, 16, 30 s, capped. */
export const backoffScheduleMs = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

export const myListKey = (orgId: string) => ['my-list', orgId] as const;

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
  private readonly transport: ListTransport;
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
    if (this.queue.length === 0 && !this.flushing) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
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
    this.queryClient.setQueryData(myListKey(item.orgId), this.replay(item.orgId));
    if (merged.refetch) void this.refetch(item.orgId);
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
