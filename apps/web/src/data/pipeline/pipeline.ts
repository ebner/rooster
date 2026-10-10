import {
  type ActivityFeed,
  applyCommentOp,
  commentIdOf,
  commentTaskId,
  findComment,
  mergeCommentResponse,
} from '@rooster/core/activity';
import { applyOpToTaskList, mergeTaskListResponse, rowsDeletedWith } from '@rooster/core/everyone';
import { uuidv7 } from '@rooster/core/ids';
import {
  type ApplyContext,
  applyOp,
  type ListOp,
  type ListOpSpec,
  type ListState,
  mergeDetailResponse,
  mergeResponse,
  normalizeMyList,
  opEntityIds,
  type ReducerContext,
} from '@rooster/core/reducers';
import type { ActivityPage, Comment, Task, TaskDetail } from '@rooster/core/schemas';
import type { QueryClient } from '@tanstack/react-query';
import { type SyncState, useSyncStore } from '../../state/sync-store';
import { ApiError } from '../errors';
import type { SyncChannel, SyncMessage, WireError } from '../sync/channel';
import type { Outbox, OutboxRecord } from '../sync/outbox';
import { classifyFailure, type ListTransport, RateLimitedError } from './transport';

/** 02 §14: 1, 2, 4, 8, 16, 30 s, capped. */
export const backoffScheduleMs = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

export const myListKey = (orgId: string) => ['my-list', orgId] as const;
/** `['task', id]` (04 §5.1): GET /tasks/:id. */
export const taskDetailKey = (taskId: string) => ['task', taskId] as const;
/** `['tags', orgId]` (04 §5.1): GET /orgs/:orgId/tags. */
export const tagsKey = (orgId: string) => ['tags', orgId] as const;
/** P6: the root of every Everyone's tasks cache of an org (`['everyone', orgId, filters]`: `Task[]`). */
export const everyoneRootKey = (orgId: string) => ['everyone', orgId] as const;
/** P6: a task's comment and activity feed (`InfiniteData<ActivityPage>`, newest page first). */
export const activityKey = (taskId: string) => ['activity', taskId] as const;

/** A queued op is exactly what the outbox stores. */
type Queued = OutboxRecord;

export interface PipelineOptions {
  transport: ListTransport;
  queryClient: QueryClient;
  /** Stable per browser profile (X-Rooster-Client-Id). */
  clientId: string;
  now?: () => number;
  backoffMs?: (failures: number) => number;
  /** P4: durable FIFO; ops are written here before they are sent. Default: memory only. */
  outbox?: Outbox;
  /** P4: the other tabs (BroadcastChannel). Default: none. */
  channel?: SyncChannel;
  /** Whether this tab holds the outbox lock (only the leader sends). Default: always. */
  isLeader?: () => boolean;
  /** Extra gate for sending, e.g. until the signed-in user is known. Default: open. */
  canSend?: () => boolean;
  /** Default: `navigator.onLine`. While offline the head op waits instead of failing. */
  isOnline?: () => boolean;
  /**
   * Resolves when outbox writes for a new op may start. The app waits for the frame that shows
   * the op to be painted: the IndexedDB write and the request then cost the keypress nothing
   * (AC-2.12), and still happen before the op is sent. Default: at once.
   */
  afterPaint?: () => Promise<void>;
  /**
   * The user ops are queued for: new records are stamped with it, and records of anyone else
   * are dropped instead of replayed or sent (a shared browser, a stale outbox). The engine
   * returns the user confirmed by `/me`, or before that the owner of the restored cache.
   * Default: no stamping and no check.
   */
  user?: () => string | null;
  /** A request still unanswered after this long is aborted and retried. Default 20 s. */
  sendTimeoutMs?: number;
}

/** How long an offline flusher sleeps before looking again (the `online` event wakes it). */
const offlineRecheckMs = 30_000;
/**
 * 04 §6.2 retries need a failure to retry: a request whose answer never comes (a connection
 * that died while the phone slept or switched networks) would hold the queue forever.
 */
export const sendTimeoutMs = 20_000;
/** A request the server did not answer in time (`sendTimeoutMs`): retried like a network error. */
export class SendTimeoutError extends Error {
  constructor(ms: number) {
    super(`no answer within ${ms} ms`);
    this.name = 'SendTimeoutError';
  }
}

/** How many settled op ids a tab remembers, so a late copy of a settled op is not queued again. */
const settledMemory = 1_000;

/** The op that created a client tag, and what the server says it really is. */
interface TagRemap {
  from: string;
  to: string;
}

/** `409 tag_name_taken` carries the id of the tag that already has the name (ADR 0007 P4). */
function existingTagId(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || error.code !== 'tag_name_taken') return undefined;
  const id = error.problem?.existingId;
  return typeof id === 'string' ? id : undefined;
}

function toWire(error: unknown): WireError {
  if (error instanceof ApiError) {
    return { code: error.code, status: error.status, message: error.message };
  }
  return { code: 'unknown', status: 0, message: String(error) };
}

function lastErrorOf(error: unknown): string {
  if (error instanceof ApiError) return error.code;
  return 'network';
}

/** Rewrites every reference to tag `from` in an op (the ids are part of the request). */
export function remapTagInOp(op: ListOp, { from, to }: TagRemap): ListOp {
  if ((op.kind === 'task.addTag' || op.kind === 'task.removeTag') && op.payload.tagId === from) {
    return { ...op, payload: { ...op.payload, tagId: to } };
  }
  if (op.kind === 'task.create' && op.payload.tagIds?.includes(from)) {
    const tagIds = [...new Set(op.payload.tagIds.map((id) => (id === from ? to : id)))];
    return { ...op, payload: { ...op.payload, tagIds } };
  }
  return op;
}

/** Replaces tag `from` with `to` on every task of a list state (keeps untouched identities). */
function remapTagInState(state: ListState, { from, to }: TagRemap): ListState {
  let tasks: Record<string, Task> | null = null;
  for (const [id, task] of Object.entries(state.tasks)) {
    if (!task.tagIds.includes(from)) continue;
    tasks ??= { ...state.tasks };
    tasks[id] = { ...task, tagIds: [...new Set(task.tagIds.map((t) => (t === from ? to : t)))] };
  }
  return tasks ? { ...state, tasks } : state;
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
 *
 * P6: ops also go straight into the Everyone's tasks caches (`['everyone', orgId, …]`) and the
 * activity feeds (`['activity', taskId]`). Those caches have no base here: their query
 * functions replay the queue over each fetch (`withPendingTasks`, `withPendingActivity`), a
 * confirmation merges the server's DTO unless a later queued op touches the same entity, and a
 * dropped op refetches them.
 */
export class ListPipeline {
  readonly transport: ListTransport;
  private readonly queryClient: QueryClient;
  private readonly clientId: string;
  private readonly now: () => number;
  private readonly backoffMs: (failures: number) => number;
  private readonly bases = new Map<string, ListState>();
  private queue: Queued[] = [];
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
  private readonly outbox: Outbox | undefined;
  private readonly channel: SyncChannel | undefined;
  private readonly isLeader: () => boolean;
  private readonly canSend: () => boolean;
  private readonly isOnline: () => boolean;
  private readonly afterPaint: () => Promise<void>;
  /** Outbox writes in order; a send waits for them (write-ahead, 04 §6.2). */
  private persisted: Promise<void> = Promise.resolve();
  /**
   * Bumped by `reset()`. A write queued before a reset (e.g. an op waiting for its paint) is
   * skipped, so it cannot put records back after sign-out cleared the outbox.
   */
  private generation = 0;
  /**
   * Bumped by `endSession()` and `reset()`: a read or a confirmation that was out before
   * belongs to a session whose caches are gone, and must not write them back.
   */
  private session = 0;
  private readonly user: (() => string | null) | undefined;
  private lastError: string | null = null;
  private readonly sendTimeout: number;
  /** Queued ops known to be in the shared outbox (see `syncWithOutbox`). */
  private readonly stored = new Set<string>();
  /** Recently confirmed, dropped or discarded ops: never queued again. */
  private readonly settled = new Set<string>();
  /** Rows the Everyone caches lost to a queued delete, by deleted task (for an undo). */
  private readonly deletedRows = new Map<string, readonly Task[]>();
  /** Comments the activity feeds lost to a queued delete (for an undo). */
  private readonly deletedComments = new Map<string, Comment>();

  constructor(options: PipelineOptions) {
    this.transport = options.transport;
    this.queryClient = options.queryClient;
    this.clientId = options.clientId;
    this.now = options.now ?? Date.now;
    this.backoffMs =
      options.backoffMs ??
      ((n) => backoffScheduleMs[Math.min(n, backoffScheduleMs.length) - 1] ?? 30_000);
    this.outbox = options.outbox;
    this.channel = options.channel;
    this.isLeader = options.isLeader ?? (() => true);
    this.canSend = options.canSend ?? (() => true);
    this.isOnline = options.isOnline ?? (() => globalThis.navigator?.onLine ?? true);
    this.afterPaint = options.afterPaint ?? (() => Promise.resolve());
    this.user = options.user;
    this.sendTimeout = options.sendTimeoutMs ?? sendTimeoutMs;
  }

  /** Whether a record belongs to someone other than the current user (never sent or shown). */
  private foreign(item: Queued): boolean {
    const owner = this.user?.() ?? null;
    return owner !== null && item.userId !== owner;
  }

  /** The query function for `['my-list', orgId]`: fetch, rebase, replay pending ops. */
  async fetch(orgId: string): Promise<ListState> {
    const seqAtStart = this.confirmSeq;
    const session = this.session;
    const list = await this.transport.fetchMyList(orgId);
    if (session !== this.session) throw new ApiError('aborted', 0);
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

  /** The last server-confirmed state (what the persisted cache stores, without pending ops). */
  baseOf(orgId: string): ListState | undefined {
    return this.bases.get(orgId);
  }

  /**
   * Cold start (P4): adopts the confirmed states restored from the persisted cache and the ops
   * left in the outbox, then renders base + ops, so the restored view equals the one before
   * the reload.
   */
  restore(bases: ReadonlyMap<string, ListState>, records: readonly OutboxRecord[]): void {
    for (const [orgId, base] of bases) this.bases.set(orgId, base);
    const known = new Set(this.queue.map((item) => item.op.opId));
    const foreign: string[] = [];
    for (const record of records) {
      const id = record.op.opId;
      if (this.foreign(record)) {
        foreign.push(id);
        continue;
      }
      // A copy of an op settled since (the outbox removal may still be on its way).
      if (this.settled.has(id)) continue;
      if (!known.has(id)) {
        this.queue.push(record);
        this.applySide(record);
      }
      this.stored.add(id);
    }
    if (foreign.length > 0) this.write(() => this.outbox?.remove(foreign));
    for (const orgId of new Set([...bases.keys(), ...records.map((r) => r.orgId)])) {
      this.render(orgId);
    }
    this.publish();
    this.changed();
  }

  /** Forgets everything local (sign-out, another user): queue, confirmed states, status. */
  /**
   * The page's session is over (ADR 0051): drops the queue and refuses every later op, so an
   * edit flushed while the page unloads (an editor's unmount) is neither stored nor announced
   * under the next account.
   */
  close(): void {
    this.closed = true;
    this.reset();
  }

  private closed = false;

  /**
   * The session ended (an online 401 on `/me`; ADR 0051): the confirmed states go, and reads
   * and confirmations still out are ignored when they answer, so nothing recreates the caches
   * the engine just removed. The queue and the outbox stay: they are the user's, and flush
   * once that user signs in again (ADR 0019).
   */
  endSession(): void {
    this.session += 1;
    this.bases.clear();
    this.confirmed.length = 0;
    this.lazySyncs.clear();
    this.deletedRows.clear();
    this.deletedComments.clear();
    this.changed();
  }

  reset(): void {
    this.generation += 1;
    this.session += 1;
    this.queue = [];
    this.bases.clear();
    this.confirmed.length = 0;
    this.stored.clear();
    this.settled.clear();
    this.failures = 0;
    this.paused = false;
    this.lastError = null;
    this.lazySyncs.clear();
    this.deletedRows.clear();
    this.deletedComments.clear();
    this.wake?.();
    this.publish();
    this.changed();
  }

  /**
   * `/me` confirmed who is signed in: queued ops of anyone else leave the queue, the view
   * and the outbox unsent.
   */
  retainUser(): void {
    this.discard((item) => this.foreign(item));
  }

  /**
   * Membership revoked (the org left `/me`): its queued ops and confirmed state go. The ops
   * would be refused anyway; until then they must not render or sit in the outbox.
   */
  forgetOrgs(orgIds: ReadonlySet<string>): void {
    for (const orgId of orgIds) {
      this.bases.delete(orgId);
      this.lazySyncs.delete(orgId);
    }
    this.discard((item) => orgIds.has(item.orgId));
  }

  /** Removes matching ops without telling the server or the drop listeners. */
  private discard(match: (item: Queued) => boolean): void {
    const gone = this.queue.filter(match);
    if (gone.length === 0) return;
    this.queue = this.queue.filter((item) => !match(item));
    const ids = gone.map((item) => item.op.opId);
    for (const id of ids) this.markSettled(id);
    this.write(() => this.outbox?.remove(ids));
    for (const orgId of new Set(gone.map((item) => item.orgId))) this.render(orgId);
    for (const item of gone) this.refetchSide(item);
    this.publish();
    this.changed();
    this.settleIdle();
  }

  /** Every org with a confirmed state or queued ops. */
  orgIds(): Set<string> {
    return new Set([...this.bases.keys(), ...this.queue.map((item) => item.orgId)]);
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

  /**
   * Whether a task or comment still has an op in the queue (unsent or unanswered): the comment
   * composer shows "Sending…" while it does. Matches the IDs of `opEntityIds`.
   */
  hasPending(entityId: string): boolean {
    return this.queue.some((item) => opEntityIds(item.op).includes(entityId));
  }

  /**
   * For the query function of an Everyone's tasks cache: the fetched rows with the org's
   * queued ops applied, so a refetch never hides an op the server has not confirmed yet.
   */
  withPendingTasks(orgId: string, tasks: readonly Task[]): Task[] {
    let rows = tasks;
    for (const item of this.queue) {
      if (item.orgId === orgId) rows = applyOpToTaskList(rows, item.op, this.rowContext(item));
    }
    return rows as Task[];
  }

  /**
   * For the query function of `['activity', taskId]`: one fetched page with the task's queued
   * comment ops applied. `newest` is the page fetched without a cursor, the only one queued
   * comments are appended to.
   */
  withPendingActivity(taskId: string, page: ActivityPage, newest: boolean): ActivityPage {
    let feed: ActivityFeed = { pages: [page], pageParams: [null] };
    for (const item of this.queue) {
      if (commentTaskId(item.op) !== taskId) continue;
      if (!newest && (item.op.kind === 'comment.create' || item.op.kind === 'comment.restore')) {
        continue;
      }
      feed = applyCommentOp(feed, item.op, this.commentContext(item));
    }
    return feed.pages[0] as ActivityPage;
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
    if (this.closed) return [];
    // Without a loaded list (a comment from a pane opened by link) the ops still queue; the
    // list's first fetch replays them.
    let view = this.view(orgId) ?? this.bases.get(orgId);
    const ops: ListOp[] = [];
    const items: Queued[] = [];
    const userId = this.user?.() ?? null;
    for (const spec of specs) {
      const op = { ...spec, opId: uuidv7(), editTime: this.now(), clientId: this.clientId };
      const item: Queued = userId === null ? { op, orgId, ctx } : { op, orgId, ctx, userId };
      if (view) view = this.apply(view, item);
      this.queue.push(item);
      this.applySide(item);
      items.push(item);
      ops.push(op);
    }
    if (view) this.queryClient.setQueryData(myListKey(orgId), view);
    const generation = this.generation;
    let stored = false;
    this.write(async () => {
      await this.afterPaint();
      if (generation !== this.generation || !this.outbox) return;
      await this.outbox.put(items);
      stored = true;
      for (const item of items) if (this.find(item.op.opId)) this.stored.add(item.op.opId);
    }).then(() => {
      if (generation !== this.generation) return;
      this.channel?.post({ type: 'enqueued', records: items, stored });
    });
    this.publish();
    this.changed();
    void this.flush();
    return ops;
  }

  /**
   * Chains an outbox write; failures (quota, private mode) leave the op in memory only. A write
   * still waiting when `reset()` runs is skipped.
   */
  private write(run: () => Promise<void> | undefined): Promise<void> {
    const generation = this.generation;
    const guarded = () => (generation === this.generation ? run() : undefined);
    this.persisted = this.persisted.then(guarded).catch((error: unknown) => {
      console.warn('rooster: outbox write failed', error);
    });
    return this.persisted;
  }

  /**
   * A message from another tab (04 §6.2): their queued ops, the leader's confirmations,
   * drops and tag remaps, its status, and flush requests for the leader.
   */
  receive(message: SyncMessage): void {
    switch (message.type) {
      case 'enqueued': {
        const known = new Set(this.queue.map((item) => item.op.opId));
        const fresh = message.records.filter(
          (r) => !known.has(r.op.opId) && !this.settled.has(r.op.opId) && !this.foreign(r),
        );
        if (fresh.length === 0) return;
        this.queue.push(...fresh);
        for (const r of fresh) this.applySide(r);
        if (message.stored !== false) for (const r of fresh) this.stored.add(r.op.opId);
        for (const orgId of new Set(fresh.map((r) => r.orgId))) this.render(orgId);
        this.publish();
        this.changed();
        void this.flush();
        return;
      }
      case 'applied': {
        const item = this.take(message.opId);
        if (!item) {
          // Not queued here (yet): a late `enqueued` for it must not queue it.
          this.markSettled(message.opId);
          return;
        }
        this.confirm(item, message.response);
        this.publish();
        this.changed();
        this.settleIdle();
        return;
      }
      case 'dropped': {
        const item = this.find(message.opId);
        if (!item) return;
        const { code, status, message: detail } = message.error;
        this.drop(item, new ApiError(code, status, detail));
        this.publish();
        this.changed();
        this.settleIdle();
        return;
      }
      case 'remap':
        this.remapTag(message.opId, { from: message.from, to: message.to }, false);
        this.publish();
        this.changed();
        return;
      case 'flush':
        if (this.isLeader()) this.retryNow();
        return;
      case 'ping':
        // Only a leader that can send answers: otherwise the asking tab should take over.
        if (this.isLeader() && this.canSend()) {
          this.announce();
          this.resume();
        }
        return;
      case 'status':
        if (!this.isLeader()) useSyncStore.setState(message.status);
        return;
      case 'cleared':
        return;
    }
  }

  private find(opId: string): Queued | undefined {
    return this.queue.find((item) => item.op.opId === opId);
  }

  /** Removes an op from the queue by id (other tabs may have changed the queue meanwhile). */
  private take(opId: string): Queued | undefined {
    const index = this.queue.findIndex((item) => item.op.opId === opId);
    if (index < 0) return undefined;
    const [item] = this.queue.splice(index, 1);
    this.markSettled(opId);
    return item;
  }

  private markSettled(opId: string): void {
    this.stored.delete(opId);
    this.settled.delete(opId);
    this.settled.add(opId);
    if (this.settled.size > settledMemory) {
      const oldest = this.settled.values().next().value;
      if (oldest !== undefined) this.settled.delete(oldest);
    }
  }

  /**
   * Brings this tab's queue in line with the shared outbox (04 §6.2), which is the truth all
   * tabs write to: ops another tab settled while this one missed the message (it was starting,
   * frozen, or its channel dropped it) leave the queue, and ops it never heard of join it.
   * Without this a stale mirrored op keeps "Syncing…" up, and blocks app updates, for good.
   * Only for an outbox shared by every tab (IndexedDB).
   */
  async syncWithOutbox(load: () => Promise<readonly OutboxRecord[]>): Promise<void> {
    await this.persisted;
    const generation = this.generation;
    const before = new Set(this.stored);
    const records = await load();
    if (generation !== this.generation) return;
    const present = new Set(records.map((record) => record.op.opId));
    const gone = this.queue.filter(
      (item) => before.has(item.op.opId) && !present.has(item.op.opId),
    );
    for (const item of gone) this.take(item.op.opId);
    // Confirmed or dropped elsewhere: which one, and the server state, a refetch tells.
    for (const orgId of new Set(gone.map((item) => item.orgId))) void this.refetch(orgId);
    for (const item of gone) this.refetchSide(item);
    if (gone.length > 0) void this.queryClient.invalidateQueries({ queryKey: ['task'] });
    this.restore(new Map(), records);
    this.settleIdle();
  }

  /** Writes base + pending ops of an org to the cache (nothing before its first load). */
  private render(orgId: string): void {
    if (!this.bases.has(orgId)) return;
    this.queryClient.setQueryData(myListKey(orgId), this.replay(orgId));
  }

  onDropped(listener: DropListener): () => void {
    this.dropListeners.add(listener);
    return () => this.dropListeners.delete(listener);
  }

  /** "Sync problem · Retry", reconnects and sign-in: try the head op now. */
  retryNow(): void {
    this.paused = false;
    if (!this.isLeader()) {
      this.channel?.post({ type: 'flush' });
      return;
    }
    this.wake?.();
    void this.flush();
  }

  /** The leader just took over (or the send gate opened): pick up where the queue stands. */
  resume(): void {
    this.publish();
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

  private apply(state: ListState, item: Queued): ListState {
    return applyOp(state, item.op, this.applyContext(item));
  }

  private replay(orgId: string): ListState {
    let state = this.bases.get(orgId) as ListState;
    for (const item of this.queue) {
      if (item.orgId === orgId) state = this.apply(state, item);
    }
    return state;
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.paused || !this.isLeader() || !this.canSend()) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0 && !this.paused && this.isLeader() && this.canSend()) {
        // Write-ahead: an op is in the outbox before its request leaves.
        await this.persisted;
        if (!this.isOnline()) {
          this.publish();
          await this.sleep(offlineRecheckMs);
          continue;
        }
        const head = this.queue[0];
        if (!head) break;
        if (this.foreign(head)) {
          this.discard((item) => item === head);
          continue;
        }
        if (!useSyncStore.getState().syncing) this.publish(true);
        const session = this.session;
        let response: unknown;
        try {
          response = await this.send(head);
        } catch (error) {
          await this.fail(head, error);
          this.publish();
          this.changed();
          continue;
        }
        // The head may have left meanwhile (reset, another tab's drop); confirm by id.
        if (this.take(head.op.opId)) {
          this.failures = 0;
          this.lastError = null;
          this.write(() => this.outbox?.remove([head.op.opId]));
          this.channel?.post({ type: 'applied', opId: head.op.opId, response });
          try {
            // The server has it; the caches of a session that ended meanwhile stay gone.
            if (session === this.session) this.confirm(head, response);
          } catch (error) {
            // The server has the op: a merge bug must not resend it. The refetch shows its state.
            console.error('rooster: could not merge a confirmation', error);
            void this.refetch(head.orgId);
          }
        }
        this.publish();
        this.changed();
      }
    } finally {
      this.flushing = false;
      this.publish();
      this.settleIdle();
    }
  }

  /**
   * One request. Unanswered after `sendTimeout` it is aborted and fails as a transient error,
   * so the head is retried with the same Idempotency-Key instead of waiting forever.
   */
  private send(item: Queued): Promise<unknown> {
    const controller = new AbortController();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort();
        reject(new SendTimeoutError(this.sendTimeout));
      }, this.sendTimeout);
      this.transport
        .send(item.op, item.orgId, controller.signal)
        .then(resolve, reject)
        .finally(() => clearTimeout(timer));
    });
  }

  private settleIdle(): void {
    if (this.queue.length === 0) {
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  private confirm(item: Queued, response: unknown): void {
    this.confirmList(item, response);
    this.confirmDetails(item, response);
    this.confirmSide(item, response);
    const { op } = item;
    const newTags = op.kind === 'task.create' && (op.payload.tagNames?.length ?? 0) > 0;
    if (op.kind === 'tag.create' || newTags) {
      void this.queryClient.invalidateQueries({ queryKey: tagsKey(item.orgId) });
    }
  }

  private confirmList(item: Queued, response: unknown): void {
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

  private applyContext({ op, ctx }: Queued): ApplyContext {
    return { ...ctx, now: op.editTime };
  }

  private rowContext(item: Queued) {
    return { ...this.applyContext(item), recall: (id: string) => this.deletedRows.get(id) };
  }

  private commentContext(item: Queued) {
    return { ...this.applyContext(item), recall: (id: string) => this.deletedComments.get(id) };
  }

  /** The optimistic half for the P6 caches: every Everyone's tasks cache and the task's feed. */
  private applySide(item: Queued): void {
    const { op } = item;
    const deletes =
      op.kind === 'task.delete'
        ? [op.entityId]
        : op.kind === 'task.bulk' && op.payload.op === 'delete'
          ? op.payload.ids
          : [];
    for (const [key, rows] of this.queryClient.getQueriesData<Task[]>({
      queryKey: everyoneRootKey(item.orgId),
    })) {
      if (!Array.isArray(rows)) continue;
      for (const [id, gone] of rowsDeletedWith(rows, deletes)) this.deletedRows.set(id, gone);
      const next = applyOpToTaskList(rows, op, this.rowContext(item));
      if (next !== rows) this.queryClient.setQueryData(key, next);
    }
    const taskId = commentTaskId(op);
    if (taskId === null) return;
    const key = activityKey(taskId);
    const feed = this.queryClient.getQueryData<ActivityFeed>(key);
    if (!feed?.pages) return;
    if (op.kind === 'comment.delete') {
      const comment = findComment(feed, op.entityId);
      if (comment) this.deletedComments.set(op.entityId, comment);
    }
    const next = applyCommentOp(feed, op, this.commentContext(item));
    if (next !== feed) this.queryClient.setQueryData(key, next);
  }

  /**
   * The server's answer into the P6 caches. While a later queued op touches the same entity
   * the optimistic copy stays: the answer predates that op, and its own answer follows.
   */
  private confirmSide(item: Queued, response: unknown): void {
    const { op } = item;
    const busy = new Set(this.queue.flatMap((queued) => opEntityIds(queued.op)));
    const settledRows = !opEntityIds(op).some((id) => busy.has(id));
    let refetch = false;
    for (const [key, rows] of this.queryClient.getQueriesData<Task[]>({
      queryKey: everyoneRootKey(item.orgId),
    })) {
      if (!Array.isArray(rows)) continue;
      const merged = mergeTaskListResponse(rows, op, response);
      refetch ||= merged.refetch;
      if (settledRows && merged.tasks !== rows) this.queryClient.setQueryData(key, merged.tasks);
    }
    if (refetch) {
      void this.queryClient.invalidateQueries({ queryKey: everyoneRootKey(item.orgId) });
    }
    const taskId = commentTaskId(op);
    const commentId = commentIdOf(op);
    if (taskId === null || commentId === null || busy.has(commentId)) return;
    if (op.kind === 'comment.delete' || op.kind === 'comment.restore') {
      // Settled: an undo now goes through a fresh delete, which captures the comment again.
      this.deletedComments.delete(commentId);
    }
    const key = activityKey(taskId);
    const feed = this.queryClient.getQueryData<ActivityFeed>(key);
    if (!feed?.pages) return;
    const next = mergeCommentResponse(feed, op, response);
    if (next !== feed) this.queryClient.setQueryData(key, next);
  }

  /** A dropped or discarded op leaves the P6 caches through a refetch (they have no base). */
  private refetchSide(item: Queued): void {
    void this.queryClient.invalidateQueries({ queryKey: everyoneRootKey(item.orgId) });
    const taskId = commentTaskId(item.op);
    if (taskId !== null) void this.queryClient.invalidateQueries({ queryKey: activityKey(taskId) });
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
        if (item.op.kind === 'tag.create' && error instanceof ApiError) {
          const to = existingTagId(error) ?? (await this.findTagByName(item));
          if (to && to !== item.op.entityId) {
            this.remapTag(item.op.opId, { from: item.op.entityId, to }, true);
            return;
          }
        }
        this.failures = 0;
        this.lastError = null;
        if (this.drop(item, error)) {
          this.write(() => this.outbox?.remove([item.op.opId]));
          this.channel?.post({ type: 'dropped', opId: item.op.opId, error: toWire(error) });
        }
        return;
      }
      case 'auth':
        this.paused = true;
        this.lastError = lastErrorOf(error);
        useSyncStore.setState({ sessionExpired: true });
        return;
      case 'rate':
        await this.sleep(error instanceof RateLimitedError ? error.retryAfterMs : 5_000);
        return;
      case 'transient':
        // Offline is not a sync problem: the loop waits for the `online` event instead.
        if (!this.isOnline()) return;
        this.failures += 1;
        this.lastError = lastErrorOf(error);
        this.publish();
        await this.sleep(this.backoffMs(this.failures));
        return;
    }
  }

  /**
   * 403/404/409/410/422: never going to succeed. Reverts the op (it leaves the replay),
   * refetches what it touched and tells the UI why. Returns false when it was already gone.
   */
  private drop(item: Queued, error: unknown): boolean {
    const before = this.view(item.orgId);
    if (!this.take(item.op.opId)) return false;
    this.render(item.orgId);
    void this.refetch(item.orgId);
    this.refetchSide(item);
    void this.queryClient.invalidateQueries({ queryKey: ['task'] });
    void this.queryClient.invalidateQueries({ queryKey: tagsKey(item.orgId) });
    for (const listener of this.dropListeners) {
      listener({ op: item.op, error: error as ApiError, before });
    }
    return true;
  }

  /** Without `existingId` in the problem body, the org's tags tell which tag has the name. */
  private async findTagByName(item: Queued): Promise<string | undefined> {
    if (item.op.kind !== 'tag.create') return undefined;
    const name = item.op.payload.name.toLocaleLowerCase();
    try {
      const tags = await this.transport.fetchTags(item.orgId);
      return tags.find((t) => t.name.toLocaleLowerCase() === name)?.id;
    } catch {
      return undefined;
    }
  }

  /**
   * `409 tag_name_taken` for a queued `tag.create` (two devices created the same tag offline,
   * ADR 0007): the existing tag wins. The create leaves the queue and every queued op and
   * cached task that uses the client id switches to the existing id; nothing is reverted.
   */
  private remapTag(opId: string, remap: TagRemap, leader: boolean): void {
    const created = this.take(opId);
    const orgId = created?.orgId;
    const rewritten: Queued[] = [];
    this.queue = this.queue.map((item) => {
      const op = remapTagInOp(item.op, remap);
      if (op === item.op) return item;
      const next = { ...item, op };
      rewritten.push(next);
      return next;
    });
    for (const [org, base] of this.bases) {
      const next = remapTagInState(base, remap);
      if (next !== base) this.bases.set(org, next);
    }
    for (const org of new Set([...(orgId ? [orgId] : []), ...rewritten.map((r) => r.orgId)])) {
      this.render(org);
      void this.queryClient.invalidateQueries({ queryKey: tagsKey(org) });
    }
    if (!leader) return;
    this.write(async () => {
      await this.outbox?.remove([opId]);
      await this.outbox?.put(rewritten);
    });
    this.channel?.post({ type: 'remap', opId, ...remap });
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

  /** The leader's answer to a `ping`: its sender state, whether or not it changed. */
  private announce(): void {
    const { syncing, failures, lastError, sessionExpired } = useSyncStore.getState();
    this.channel?.post({
      type: 'status',
      status: { syncing, failures, lastError, sessionExpired },
    });
  }

  /**
   * Publishes the queue to the sync store. Only the leader knows the sender's state; it shares
   * it with the other tabs, which keep their own (mirrored) queue length.
   */
  private publish(sending = false): void {
    const leader = this.isLeader();
    const state: Partial<SyncState> = { pending: this.queue.length };
    if (leader) {
      const status = {
        syncing: (sending || this.flushing) && this.queue.length > 0 && this.isOnline(),
        failures: this.failures,
        lastError: this.lastError,
        // Only a 401 pauses; it sets the flag, and the next unpaused publish clears it.
        sessionExpired: this.paused && useSyncStore.getState().sessionExpired,
      };
      Object.assign(state, status);
      const current = useSyncStore.getState();
      if (
        current.syncing !== status.syncing ||
        current.failures !== status.failures ||
        current.lastError !== status.lastError ||
        current.sessionExpired !== status.sessionExpired
      ) {
        this.channel?.post({ type: 'status', status });
      }
    }
    useSyncStore.setState(state);
  }
}
