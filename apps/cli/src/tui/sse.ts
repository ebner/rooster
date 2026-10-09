/**
 * A small Server-Sent Events client over `fetch` for `GET /api/v1/events` (04 §4.5), since
 * Node has no `EventSource` that can send a bearer token. It reconnects with the web client's
 * backoff (1 s → 30 s), treats a silent stream (no bytes for two heartbeats) as dead, and
 * reports its state for the TUI's sync status.
 */

export interface SseMessage {
  event: string;
  data: string;
  id: string | null;
}

/** The server's `: ping` interval (`SSE_HEARTBEAT_MS` in `@rooster/core/schemas`, 25 s). */
export const HEARTBEAT_MS = 25_000;
/** A stream that has sent nothing (not even a ping) for this long is reconnected. */
export const STALL_MS = 2 * HEARTBEAT_MS + 5_000;
/** The web client's reconnect backoff (04 §4.5). */
export const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

/**
 * Incremental `text/event-stream` parsing (WHATWG HTML §9.2.6): feed chunks, get complete
 * messages. Comments (`: ping`) produce none; a message without `event:` is `message`.
 */
export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];
  private id: string | null = null;

  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const out: SseMessage[] = [];
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (match === null) break;
      // A lone `\r` at the end may be the first half of `\r\n`: wait for more.
      if (match[0] === '\r' && match.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const message = this.line(line);
      if (message !== null) out.push(message);
    }
    return out;
  }

  private line(line: string): SseMessage | null {
    if (line === '') {
      if (this.data.length === 0) {
        this.event = '';
        return null;
      }
      const message = { event: this.event || 'message', data: this.data.join('\n'), id: this.id };
      this.event = '';
      this.data = [];
      return message;
    }
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
    else if (field === 'id' && !value.includes('\u0000')) this.id = value;
    return null;
  }
}

export type SseState = 'connecting' | 'open' | 'offline';

export interface SseClientOptions {
  url: string;
  /** Request headers per attempt (the token is read fresh, so a re-login is picked up). */
  headers: () => Promise<Record<string, string>>;
  fetch: typeof fetch;
  onMessage: (message: SseMessage) => void;
  /** Every change of state; `open` after each (re)connect, when missed events must be refetched. */
  onState: (state: SseState) => void;
  /** A 401/403 answer: the credential is gone; the client stops retrying. */
  onDenied?: (status: number) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class SseClient {
  private stopped = true;
  private controller: AbortController | null = null;
  private retryTimer: unknown = null;
  private stallTimer: unknown = null;
  private failures = 0;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: SseClientOptions) {
    this.setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        handle.unref?.();
        return handle;
      });
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer(this.retryTimer);
    this.clearTimer(this.stallTimer);
    this.controller?.abort();
    this.controller = null;
  }

  /** Drops the current stream and connects again at once (e.g. the user asked to retry). */
  reconnect(): void {
    if (this.stopped) return;
    this.failures = 0;
    this.clearTimer(this.retryTimer);
    this.controller?.abort();
    void this.connect();
  }

  private armStall(): void {
    this.clearTimer(this.stallTimer);
    this.stallTimer = this.setTimer(() => this.controller?.abort(), STALL_MS);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const controller = new AbortController();
    this.controller = controller;
    this.options.onState(this.failures === 0 ? 'connecting' : 'offline');
    let opened = false;
    try {
      const headers = await this.options.headers();
      const response = await this.options.fetch(this.options.url, {
        headers: { ...headers, Accept: 'text/event-stream', 'Cache-Control': 'no-cache' },
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => {});
        this.options.onDenied?.(response.status);
        this.stopped = true;
        this.options.onState('offline');
        return;
      }
      if (!response.ok || response.body === null) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`HTTP ${response.status}`);
      }
      opened = true;
      this.failures = 0;
      this.armStall();
      this.options.onState('open');
      const parser = new SseParser();
      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.armStall();
        for (const message of parser.push(decoder.decode(value, { stream: true }))) {
          this.options.onMessage(message);
        }
      }
    } catch {
      // A network failure, an abort (stall or stop) or a bad status: retry below.
    } finally {
      this.clearTimer(this.stallTimer);
    }
    if (this.stopped || this.controller !== controller) return;
    if (!opened) this.failures += 1;
    this.options.onState(opened ? 'connecting' : 'offline');
    const delay = BACKOFF_MS[Math.min(this.failures - 1, BACKOFF_MS.length - 1)] ?? 30_000;
    // A stream that ended normally (server restart) reconnects after the first step.
    this.retryTimer = this.setTimer(() => void this.connect(), opened ? BACKOFF_MS[0] : delay);
  }
}
