import { SSE_HEARTBEAT_MS, type SseHello, type SseInvalidate } from '@rooster/core/schemas';
import type { Logger } from '../lib/logger.ts';
import type { DomainEvent, EventBus, PriorGroups, QueryKey } from './bus.ts';

/** Invalidations for one stream are collected this long, so a burst becomes one event. */
export const SSE_COALESCE_MS = 50;
/** Above this many keys in one event, keys sharing a first segment collapse to it. */
export const SSE_MAX_KEYS = 64;
/**
 * Open streams allowed per session and per user. One more closes the oldest instead of
 * refusing the new one: the newest is the tab the person is looking at, and a reload's old
 * stream may not have been noticed as gone yet.
 */
export const SSE_MAX_PER_SESSION = 4;
export const SSE_MAX_PER_USER = 12;

/** The transport under one stream: raw `text/event-stream` text, written in call order. */
export interface SseSink {
  write(text: string): void;
  close(): void;
}

export interface SseHubOptions {
  version: string;
  gitSha: string;
  clock: () => number;
  heartbeatMs?: number;
  coalesceMs?: number;
  logger?: Logger;
}

export interface SseOpen {
  userId: string;
  sessionId: string;
  sink: SseSink;
  /**
   * Re-checked on every heartbeat: the session still exists and the user is enabled. Catches
   * ends no event reports, such as a session that simply expired.
   */
  isValid: () => boolean;
  /** A grant's stream (P8): the keys of an invalidation it may receive (possibly none). */
  filterKeys?: (
    org: string | null,
    keys: readonly QueryKey[],
    prior?: PriorGroups,
  ) => readonly QueryKey[];
  /**
   * A grant's stream (P8): rewrites a `notification` message for what the grant may see, or
   * drops it (`null`).
   */
  notification?: (data: unknown) => unknown | null;
  /** Called once when the stream is closed, for any reason. */
  onClose?: () => void;
}

export interface SseHandle {
  close(): void;
}

interface Bucket {
  org: string | null;
  origin: string | null;
  keys: Map<string, QueryKey>;
}

interface Connection extends SseOpen {
  closed: boolean;
  pending: Map<string, Bucket>;
  flushTimer: ReturnType<typeof setTimeout> | undefined;
  heartbeat: ReturnType<typeof setInterval>;
}

/** `event:`/`id:`/`data:` framing; JSON never contains a raw newline. */
function frame(event: string, id: number, data: unknown): string {
  return `event: ${event}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Drops keys made redundant by a shorter prefix in the same set (`['task']` covers
 * `['task', id]`), and above `max` keys collapses each first segment that occurs more than
 * once to the bare segment: a bulk tag delete invalidates `['task']`, not 500 task keys.
 */
export function compactKeys(keys: readonly QueryKey[], max = SSE_MAX_KEYS): QueryKey[] {
  const ids = new Set(keys.map((k) => JSON.stringify(k)));
  const covered = (key: QueryKey) =>
    key.some((_, i) => i > 0 && ids.has(JSON.stringify(key.slice(0, i))));
  let out = keys.filter((k) => !covered(k));
  if (out.length <= max) return out;
  const counts = new Map<string, number>();
  for (const k of out) counts.set(k[0] ?? '', (counts.get(k[0] ?? '') ?? 0) + 1);
  const seen = new Set<string>();
  out = out.flatMap((k) => {
    const head = k[0] ?? '';
    if ((counts.get(head) ?? 0) < 2) return [k];
    if (seen.has(head)) return [];
    seen.add(head);
    return [[head]];
  });
  return out;
}

/**
 * The SSE hub (04 §4.5, WP 4.3): one entry per open `GET /api/v1/events` stream, indexed by
 * user. Every domain event names its audiences (user IDs resolved inside the emitting
 * transaction), so the hub keeps no org subscriptions of its own: a membership change is in
 * effect for the very next event, including the membership event itself.
 */
export class SseHub {
  private seq = 0;
  private stopped = false;
  private readonly byUser = new Map<string, Set<Connection>>();
  private readonly heartbeatMs: number;
  private readonly coalesceMs: number;
  private readonly unsubscribe: () => void;

  constructor(
    bus: EventBus,
    private readonly options: SseHubOptions,
  ) {
    this.heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_MS;
    this.coalesceMs = options.coalesceMs ?? SSE_COALESCE_MS;
    this.unsubscribe = bus.on((event) => this.dispatch(event));
  }

  /** Open streams, for tests and `/metrics` (P10). */
  get size(): number {
    let n = 0;
    for (const set of this.byUser.values()) n += set.size;
    return n;
  }

  /** False once shutdown started: new streams are refused. */
  get accepting(): boolean {
    return !this.stopped;
  }

  /** The next `id:` value; monotonic for the life of the process. */
  private nextId(): number {
    this.seq += 1;
    return this.seq;
  }

  /**
   * Registers a stream and sends `hello`; `null` during shutdown. Closes the session's or
   * user's oldest streams first when the new one would exceed their cap.
   */
  open(input: SseOpen): SseHandle | null {
    if (this.stopped) return null;
    this.makeRoom(input.userId, input.sessionId);
    const conn: Connection = {
      ...input,
      closed: false,
      pending: new Map(),
      flushTimer: undefined,
      heartbeat: setInterval(() => this.beat(conn), this.heartbeatMs),
    };
    conn.heartbeat.unref?.();
    let set = this.byUser.get(input.userId);
    if (set === undefined) {
      set = new Set();
      this.byUser.set(input.userId, set);
    }
    set.add(conn);
    const hello: SseHello = {
      version: this.options.version,
      gitSha: this.options.gitSha,
      serverTime: this.options.clock(),
    };
    conn.sink.write(frame('hello', this.nextId(), hello));
    return { close: () => this.close(conn) };
  }

  /** Sets iterate in insertion order, so the first entries are the oldest streams. */
  private makeRoom(userId: string, sessionId: string): void {
    const oldest = <T>(list: T[], cap: number) => list.slice(0, Math.max(0, list.length - cap + 1));
    const existing = [...(this.byUser.get(userId) ?? [])];
    const evicted = new Set(
      oldest(
        existing.filter((c) => c.sessionId === sessionId),
        SSE_MAX_PER_SESSION,
      ),
    );
    const remaining = existing.filter((c) => !evicted.has(c));
    for (const conn of oldest(remaining, SSE_MAX_PER_USER)) evicted.add(conn);
    for (const conn of evicted) this.close(conn);
  }

  private beat(conn: Connection): void {
    let valid: boolean;
    try {
      valid = conn.isValid();
    } catch (err) {
      this.options.logger?.warn({ err }, 'sse session check failed');
      valid = false;
    }
    if (valid) conn.sink.write(': ping\n\n');
    else this.close(conn);
  }

  private dispatch(event: DomainEvent): void {
    for (const audience of event.audiences) {
      for (const userId of new Set(audience.userIds)) {
        // The origin is the actor's client id: only the actor's own tabs need it (to skip a
        // refetch), and nobody else learns it.
        const origin = userId === event.actorId ? event.origin : null;
        for (const conn of this.byUser.get(userId) ?? []) {
          this.enqueue(conn, audience.org, origin, audience.keys, event.priorGroups);
        }
      }
    }
    for (const message of event.direct ?? []) {
      for (const conn of this.byUser.get(message.userId) ?? []) {
        if (conn.closed) continue;
        const data =
          conn.notification === undefined ? message.data : conn.notification(message.data);
        if (data !== null) conn.sink.write(frame(message.event, this.nextId(), data));
      }
    }
    if (event.type === 'session.ended') {
      for (const sessionId of event.subjects) this.closeWhere((c) => c.sessionId === sessionId);
    } else if (event.type === 'user.disabled') {
      for (const userId of event.subjects) this.closeWhere((c) => c.userId === userId);
    }
  }

  private enqueue(
    conn: Connection,
    org: string | null,
    origin: string | null,
    keys: readonly QueryKey[],
    prior?: PriorGroups,
  ): void {
    if (conn.closed || keys.length === 0) return;
    if (conn.filterKeys !== undefined) {
      keys = conn.filterKeys(org, keys, prior);
      if (keys.length === 0) return;
    }
    const slot = JSON.stringify([org, origin]);
    let bucket = conn.pending.get(slot);
    if (bucket === undefined) {
      bucket = { org, origin, keys: new Map() };
      conn.pending.set(slot, bucket);
    }
    for (const key of keys) bucket.keys.set(JSON.stringify(key), key);
    if (conn.flushTimer === undefined) {
      conn.flushTimer = setTimeout(() => this.flush(conn), this.coalesceMs);
      conn.flushTimer.unref?.();
    }
  }

  private flush(conn: Connection): void {
    conn.flushTimer = undefined;
    if (conn.closed) return;
    const buckets = [...conn.pending.values()];
    conn.pending.clear();
    for (const bucket of buckets) {
      const data: SseInvalidate = {
        org: bucket.org,
        keys: compactKeys([...bucket.keys.values()]).map((k) => [...k]),
        origin: bucket.origin,
      };
      conn.sink.write(frame('invalidate', this.nextId(), data));
    }
  }

  private closeWhere(match: (conn: Connection) => boolean): void {
    for (const set of [...this.byUser.values()]) {
      for (const conn of [...set]) if (match(conn)) this.close(conn);
    }
  }

  private close(conn: Connection): void {
    if (conn.closed) return;
    conn.closed = true;
    clearInterval(conn.heartbeat);
    if (conn.flushTimer !== undefined) clearTimeout(conn.flushTimer);
    conn.pending.clear();
    const set = this.byUser.get(conn.userId);
    set?.delete(conn);
    if (set?.size === 0) this.byUser.delete(conn.userId);
    try {
      conn.sink.close();
    } finally {
      conn.onClose?.();
    }
  }

  /** Graceful shutdown: refuse new streams and end every open one now. */
  shutdown(): number {
    const open = this.size;
    this.stopped = true;
    this.unsubscribe();
    this.closeWhere(() => true);
    return open;
  }
}
