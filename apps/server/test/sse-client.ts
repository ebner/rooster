import type { SseHello, SseInvalidate } from '@rooster/core/schemas';

export interface SseFrame {
  event: string;
  id: number;
  data: unknown;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `check` on real timers until it holds or `timeoutMs` passes. */
export async function until(check: () => boolean, timeoutMs = 1_000, what = 'condition') {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(2);
  }
}

/** A minimal `text/event-stream` reader over a fetch/`app.request` response. */
export class SseClient {
  readonly frames: SseFrame[] = [];
  readonly comments: string[] = [];
  closed = false;
  private buffer = '';
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();

  constructor(readonly response: Response) {
    if (response.body === null) throw new Error('no body');
    this.reader = response.body.getReader();
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for (;;) {
        const { done, value } = await this.reader.read();
        if (done) break;
        this.buffer += this.decoder.decode(value, { stream: true });
        this.parse();
      }
    } catch {
      // Cancelled.
    }
    this.closed = true;
  }

  private parse(): void {
    for (;;) {
      const end = this.buffer.indexOf('\n\n');
      if (end === -1) return;
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      const frame: Partial<SseFrame> = {};
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) this.comments.push(line.slice(1).trim());
        else if (line.startsWith('event: ')) frame.event = line.slice(7);
        else if (line.startsWith('id: ')) frame.id = Number(line.slice(4));
        else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6));
      }
      if (frame.event !== undefined) this.frames.push(frame as SseFrame);
    }
  }

  get hello(): SseHello | undefined {
    return this.frames.find((f) => f.event === 'hello')?.data as SseHello | undefined;
  }

  get invalidations(): SseInvalidate[] {
    return this.frames.filter((f) => f.event === 'invalidate').map((f) => f.data as SseInvalidate);
  }

  /** Every invalidated key, as `a/b` strings. */
  get keys(): string[] {
    return this.invalidations.flatMap((i) => i.keys.map((k) => k.join('/')));
  }

  async waitFor(count: number, timeoutMs = 1_000): Promise<SseInvalidate[]> {
    await until(() => this.invalidations.length >= count, timeoutMs, `${count} invalidations`);
    return this.invalidations;
  }

  async waitClosed(timeoutMs = 1_000): Promise<void> {
    await until(() => this.closed, timeoutMs, 'the stream to close');
  }

  async close(): Promise<void> {
    await this.reader.cancel().catch(() => {});
  }
}
