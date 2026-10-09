import type { SseHello, SseInvalidate, SseNotification } from '@rooster/core/schemas';
import { parseSseHello, parseSseInvalidate, parseSseNotification } from '@rooster/core/sse';
import type { SseState } from '../../state/sync-store';

export const eventsUrl = '/api/v1/events';
/** 04 §4.5: reconnect backoff while the stream keeps failing (1 s → 30 s). */
export const sseBackoffMs = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;
/**
 * A stream that never opened after this many tries is probably not there (an older server
 * without the hub answers 404): try again rarely instead of every 30 s.
 */
export const sseGiveUpAfter = 6;
export const sseLongBackoffMs = 5 * 60_000;
/** Close the stream when the page has been hidden this long; reconnect on visible. */
export const ssePauseHiddenMs = 5 * 60_000;

/** The subset of `EventSource` the client uses (tests pass a fake). */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export interface InvalidateDecision {
  /** Query keys to invalidate (empty: the event was ours and is already merged). */
  keys: readonly (readonly string[])[];
}

/**
 * The query roots the pipeline keeps itself: a confirmation already merged the server's answer
 * for this browser's own ops (and asks for a refetch when it cannot, `mergeResponse`), while
 * queued ops are replayed over whatever the cache holds.
 */
export const pipelineRoots: ReadonlySet<string> = new Set(['my-list', 'task', 'tags']);

/**
 * 04 §4.5 origin-skip: an event caused by this browser profile's own request needs no refetch
 * for the keys the pipeline merged locally. Refetching them while ops are queued (every
 * keypress while typing) would re-download and re-render the whole list for nothing (AC-2.12).
 * Other keys, and other clients' changes, are invalidated.
 */
export function invalidationKeys(
  event: SseInvalidate,
  ownClientId: string,
): readonly (readonly string[])[] {
  if (event.origin !== ownClientId) return event.keys;
  return event.keys.filter((key) => !pipelineRoots.has(key[0] ?? ''));
}

/** Whether a `hello` from the server means this bundle is outdated (04 §6.3). */
export function serverIsNewer(
  hello: Pick<SseHello, 'version' | 'gitSha'>,
  bundle: { version: string; gitSha: string },
): boolean {
  const cmp = compareVersions(hello.version, bundle.version);
  if (cmp !== 0) return cmp > 0;
  // Same version, another build (a redeploy of a snapshot): only real SHAs count.
  return hello.gitSha !== bundle.gitSha && hello.gitSha !== 'dev' && bundle.gitSha !== 'dev';
}

/** Semver-ish comparison of `major.minor.patch` (pre-release tags compare as text). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/);
  const pb = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? '';
    const y = pb[i] ?? '';
    if (x === y) continue;
    const nx = Number(x);
    const ny = Number(y);
    if (x !== '' && y !== '' && Number.isInteger(nx) && Number.isInteger(ny)) return nx - ny;
    if (i >= 3) return x === '' ? 1 : y === '' ? -1 : x < y ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

type NotificationListener = (event: SseNotification) => void;

const notificationListeners = new Set<NotificationListener>();

/**
 * The P6 `event: notification` (unread count plus a preview) for whoever shows it: the badge
 * writes the count into the inbox cache (`data/notifications.ts`). Returns the unsubscribe.
 */
export function subscribeSseNotifications(listener: NotificationListener): () => void {
  notificationListeners.add(listener);
  return () => {
    notificationListeners.delete(listener);
  };
}

function publishNotification(event: SseNotification): void {
  for (const listener of notificationListeners) listener(event);
}

/** The inbox's query root: every `notification` event refreshes the loaded lists. */
export const notificationsKey = ['notifications'] as const;

export interface EventStreamOptions {
  clientId: string;
  invalidate: (key: readonly string[]) => void;
  /** Every (re)connect: refetch active queries and flush the outbox (04 §4.5, §6.2). */
  onConnect: () => void;
  onHello: (hello: SseHello) => void;
  /** Default: `subscribeSseNotifications` listeners. */
  onNotification?: NotificationListener;
  onState: (state: SseState) => void;
  factory?: EventSourceFactory;
  url?: string;
  /** Test seams. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  isHidden?: () => boolean;
}

const OPEN = 1;
const CLOSED = 2;

/**
 * The realtime stream (04 §4.5): an `EventSource` on `/api/v1/events` that invalidates
 * query keys, reconnects with backoff, pauses while the page is hidden for 5 minutes, and
 * reports the server version.
 */
export class EventStream {
  private source: EventSourceLike | null = null;
  private retryTimer: unknown = null;
  private hiddenTimer: unknown = null;
  /** Consecutive failures without an open stream in between. */
  private failures = 0;
  private everOpened = false;
  private stopped = true;
  private paused = false;
  private readonly options: EventStreamOptions;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(options: EventStreamOptions) {
    this.options = options;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  start(): void {
    this.stopped = false;
    this.paused = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.cancelRetry();
    if (this.hiddenTimer) this.clearTimer(this.hiddenTimer);
    this.hiddenTimer = null;
    this.disconnect();
    this.options.onState('closed');
  }

  /** `online`, or the page came back: connect now instead of waiting for the backoff. */
  reconnectNow(): void {
    if (this.stopped) return;
    this.paused = false;
    if (this.source && this.source.readyState !== CLOSED) return;
    this.cancelRetry();
    this.connect();
  }

  /** `visibilitychange`: hidden for 5 minutes closes the stream; visible reopens it. */
  visibilityChanged(hidden: boolean): void {
    if (this.stopped) return;
    if (hidden) {
      if (this.hiddenTimer) return;
      this.hiddenTimer = this.setTimer(() => {
        this.hiddenTimer = null;
        this.paused = true;
        this.cancelRetry();
        this.disconnect();
        this.options.onState('paused');
      }, ssePauseHiddenMs);
      return;
    }
    if (this.hiddenTimer) this.clearTimer(this.hiddenTimer);
    this.hiddenTimer = null;
    if (this.paused) this.reconnectNow();
  }

  private connect(): void {
    if (this.stopped || this.paused) return;
    this.disconnect();
    const factory =
      this.options.factory ??
      ((url: string) => new EventSource(url, { withCredentials: true }) as EventSourceLike);
    let source: EventSourceLike;
    try {
      source = factory(this.options.url ?? eventsUrl);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.source = source;
    this.options.onState('connecting');
    source.onopen = () => {
      if (this.source !== source) return;
      this.failures = 0;
      this.everOpened = true;
      this.options.onState('open');
      this.options.onConnect();
    };
    source.onerror = () => {
      if (this.source !== source) return;
      if (source.readyState === CLOSED) {
        // Not retried by the browser (HTTP error, wrong content type): our backoff.
        this.source = null;
        source.close();
        this.scheduleRetry();
      } else {
        // The browser reconnects by itself (`retry:`); `onopen` fires again.
        this.options.onState('connecting');
      }
    };
    source.addEventListener('hello', (event) => this.onHello(event.data));
    source.addEventListener('invalidate', (event) => this.onInvalidate(event.data));
    source.addEventListener('notification', (event) => this.onNotification(event.data));
  }

  private onHello(data: string): void {
    const hello = parse(data, parseSseHello);
    if (hello) this.options.onHello(hello);
  }

  private onInvalidate(data: string): void {
    const event = parse(data, parseSseInvalidate);
    if (!event) return;
    const keys = invalidationKeys(event, this.options.clientId);
    for (const key of keys) this.options.invalidate(key);
  }

  /**
   * The unread count goes to the listeners first (the badge updates without a refetch); the
   * loaded inbox pages are then invalidated for the new item or the changed read state.
   */
  private onNotification(data: string): void {
    const event = parse(data, parseSseNotification);
    if (!event) return;
    (this.options.onNotification ?? publishNotification)(event);
    this.options.invalidate(notificationsKey);
  }

  private scheduleRetry(): void {
    if (this.stopped || this.paused) return;
    this.failures += 1;
    this.options.onState('closed');
    const delay =
      !this.everOpened && this.failures >= sseGiveUpAfter
        ? sseLongBackoffMs
        : (sseBackoffMs[Math.min(this.failures, sseBackoffMs.length) - 1] ?? 30_000);
    this.cancelRetry();
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private cancelRetry(): void {
    if (this.retryTimer) this.clearTimer(this.retryTimer);
    this.retryTimer = null;
  }

  private disconnect(): void {
    const source = this.source;
    this.source = null;
    if (source) {
      source.onopen = null;
      source.onerror = null;
      source.close();
    }
  }

  get state(): 'open' | 'other' {
    return this.source?.readyState === OPEN ? 'open' : 'other';
  }
}

function parse<T>(data: string, guard: (value: unknown) => T | null): T | null {
  try {
    return guard(JSON.parse(data));
  } catch {
    return null;
  }
}
