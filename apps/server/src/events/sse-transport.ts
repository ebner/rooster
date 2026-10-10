import type { SseSink } from './hub.ts';

/**
 * Frames one stream may hold that its client has not taken yet. Frames are small (keys are
 * compacted, notifications carry a short preview), so a healthy client never gets near it.
 */
export const SSE_MAX_BUFFERED_BYTES = 64 * 1024;
/** A stream whose client takes nothing for this long while frames wait is cut off. */
export const SSE_WRITE_DEADLINE_MS = 30_000;
/**
 * After `close()`, the transport has this long to finish the response; then it is destroyed.
 * The frame queue may be empty while the socket is not: Node may hold the last frame, waiting
 * for a client that stopped reading to drain it.
 */
export const SSE_CLOSE_GRACE_MS = 2_000;

export interface SseTransportOptions {
  maxBufferedBytes?: number;
  writeDeadlineMs?: number;
  closeGraceMs?: number;
  /** Tears down the underlying connection (the Node response), when there is one. */
  destroy?: () => void;
}

/**
 * The response body under one SSE stream, with its own bounded queue (ADR 0009). The stream
 * has no internal buffer of its own (high-water mark 0): a frame goes straight to a waiting
 * read, or waits here until the client's socket takes more. The Node adapter only reads
 * after the socket drains, so a client that stops reading leaves frames here, where they
 * are counted. Over `maxBufferedBytes`, or after `writeDeadlineMs` without progress, the
 * stream is aborted and the connection destroyed: the frames are dropped and the client's
 * `EventSource` reconnects and refetches. `close()` ends a caught-up stream cleanly (and
 * destroys it if the response has not finished `SSE_CLOSE_GRACE_MS` later) and aborts one
 * that is behind, so a closed stream never lingers behind its own backlog.
 */
export class SseTransport implements SseSink {
  readonly body: ReadableStream<Uint8Array>;
  private readonly encoder = new TextEncoder();
  private readonly maxBufferedBytes: number;
  private readonly writeDeadlineMs: number;
  private readonly closeGraceMs: number;
  private readonly destroy: (() => void) | undefined;
  private controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  private readonly queue: Uint8Array[] = [];
  private queued = 0;
  private waiting: (() => void) | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private ending = false;
  private done = false;
  private readonly abortListeners: (() => void)[] = [];

  constructor(options: SseTransportOptions = {}) {
    this.maxBufferedBytes = options.maxBufferedBytes ?? SSE_MAX_BUFFERED_BYTES;
    this.writeDeadlineMs = options.writeDeadlineMs ?? SSE_WRITE_DEADLINE_MS;
    this.closeGraceMs = options.closeGraceMs ?? SSE_CLOSE_GRACE_MS;
    this.destroy = options.destroy;
    this.body = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.controller = controller;
        },
        pull: (controller) => this.pull(controller),
        cancel: () => this.abort(),
      },
      { highWaterMark: 0 },
    );
  }

  /** Bytes waiting for the client, for tests. */
  get buffered(): number {
    return this.queued;
  }

  /** True once the stream ended or was aborted. */
  get closed(): boolean {
    return this.done || this.ending;
  }

  /** Called once if the stream is aborted: by the client, a stall or `close()` while behind. */
  onAbort(listener: () => void): void {
    this.abortListeners.push(listener);
  }

  write(text: string): void {
    if (this.closed) return;
    const chunk = this.encoder.encode(text);
    const waiting = this.waiting;
    if (waiting !== undefined && this.controller !== undefined) {
      this.waiting = undefined;
      this.controller.enqueue(chunk);
      waiting();
      return;
    }
    this.queue.push(chunk);
    this.queued += chunk.byteLength;
    if (this.queued > this.maxBufferedBytes) {
      this.abort();
      return;
    }
    if (this.deadline === undefined) {
      this.deadline = setTimeout(() => this.abort(), this.writeDeadlineMs);
      this.deadline.unref?.();
    }
  }

  close(): void {
    if (this.closed) return;
    if (this.queued > 0) {
      this.abort();
      return;
    }
    this.ending = true;
    // The hub has forgotten the stream: nothing else would ever end a stalled transport.
    if (this.destroy !== undefined) {
      const destroy = this.destroy;
      setTimeout(destroy, this.closeGraceMs).unref?.();
    }
    const waiting = this.waiting;
    if (waiting !== undefined) {
      this.waiting = undefined;
      this.finish();
      this.controller?.close();
      waiting();
    }
  }

  private pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> | void {
    const chunk = this.queue.shift();
    if (chunk !== undefined) {
      this.queued -= chunk.byteLength;
      if (this.queue.length === 0) this.clearDeadline();
      controller.enqueue(chunk);
      return;
    }
    if (this.ending) {
      this.finish();
      controller.close();
      return;
    }
    if (this.done) return;
    return new Promise<void>((resolve) => {
      this.waiting = resolve;
    });
  }

  private abort(): void {
    if (this.done) return;
    this.finish();
    this.queue.length = 0;
    this.queued = 0;
    const waiting = this.waiting;
    this.waiting = undefined;
    try {
      this.controller?.error(new Error('sse stream aborted'));
    } catch {
      // Already closed or cancelled.
    }
    waiting?.();
    this.destroy?.();
    for (const listener of this.abortListeners.splice(0)) listener();
  }

  private finish(): void {
    this.done = true;
    this.clearDeadline();
  }

  private clearDeadline(): void {
    if (this.deadline !== undefined) clearTimeout(this.deadline);
    this.deadline = undefined;
  }
}
