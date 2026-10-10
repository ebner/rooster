import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { receiveFile } from '../src/blob/multipart.ts';
import { AppError } from '../src/lib/errors.ts';

const boundary = '----roosterdrain';
const contentType = `multipart/form-data; boundary=${boundary}`;
const head = new TextEncoder().encode(
  `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
);

/** Sends the part header and `bytes` of file content, then never sends or closes again. */
function stalledBody(bytes: number) {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(head);
      for (let sent = 0; sent < bytes; sent += 64 * 1024) {
        controller.enqueue(new Uint8Array(Math.min(64 * 1024, bytes - sent)).fill(0x61));
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, cancelled: () => cancelled };
}

/** Sends one small chunk every `everyMs`, forever. */
function tricklingBody(everyMs: number) {
  let timer: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(head);
      timer = setInterval(() => controller.enqueue(new Uint8Array(1024).fill(0x61)), everyMs);
    },
    cancel() {
      clearInterval(timer);
    },
  });
  return { body, stop: () => clearInterval(timer) };
}

describe('receiveFile drain bounds (ADR 0049 §3.1)', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function rejection(promise: Promise<unknown>): Promise<AppError> {
    const error = await promise.then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }

  it('answers 413 promptly when a client declares too much and then stalls', async () => {
    dir = mkdtempSync(join(tmpdir(), 'rooster-mp-'));
    const { body } = stalledBody(0);
    const started = Date.now();
    const error = await rejection(
      receiveFile(
        { contentType, contentLength: String(3 * 1024 * 1024), body },
        { maxBytes: 1024 * 1024, tmpDir: dir, drainTimeouts: { idleMs: 50, totalMs: 5_000 } },
      ),
    );
    expect(error.status).toBe(413);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('answers 413 promptly and removes the partial file when a streamed body stalls past the limit', async () => {
    dir = mkdtempSync(join(tmpdir(), 'rooster-mp-'));
    const { body } = stalledBody(1024 * 1024 + 256 * 1024);
    const started = Date.now();
    const error = await rejection(
      receiveFile(
        { contentType, contentLength: undefined, body },
        { maxBytes: 1024 * 1024, tmpDir: dir, drainTimeouts: { idleMs: 50, totalMs: 5_000 } },
      ),
    );
    expect(error.status).toBe(413);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('stops draining a trickling client at the total deadline', async () => {
    dir = mkdtempSync(join(tmpdir(), 'rooster-mp-'));
    const { body, stop } = tricklingBody(10);
    const started = Date.now();
    try {
      const error = await rejection(
        receiveFile(
          { contentType, contentLength: String(3 * 1024 * 1024), body },
          { maxBytes: 1024 * 1024, tmpDir: dir, drainTimeouts: { idleMs: 1_000, totalMs: 150 } },
        ),
      );
      expect(error.status).toBe(413);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      stop();
    }
  });
});
