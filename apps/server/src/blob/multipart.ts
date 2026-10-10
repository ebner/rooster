import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { uuidv7 } from '@rooster/core/ids';
import busboy from 'busboy';
import { AppError } from '../lib/errors.ts';

/** `<dataDir>/tmp`: uploads in flight. Boot empties it (main.ts). */
export function uploadTmpDir(dataDir: string): string {
  return join(dataDir, 'tmp');
}

/** Room for the multipart framing (boundaries, part headers, small fields) around the file. */
export const MULTIPART_OVERHEAD = 64 * 1024;

export interface UploadRequest {
  contentType: string | undefined;
  contentLength: string | undefined;
  body: ReadableStream<Uint8Array> | null;
}

export interface ReceivedFile {
  /** The temp file under `<dataDir>/tmp`; the caller removes it. */
  path: string;
  size: number;
  /** As the client sent it (busboy keeps only the base name); cleaned by the caller. */
  filename: string;
  /** The part's `Content-Type`, as claimed by the client. */
  declaredType: string;
}

/**
 * How much of an oversized body is still read (and discarded) before the `413` goes out, on
 * top of the limit. Answering while the client is still sending makes reverse proxies (Vite,
 * Apache) see a broken upstream and answer `502` instead; past this the connection is cut.
 */
export const DRAIN_EXTRA_BYTES = 64 * 1024 * 1024;

/**
 * Time bounds on that drain: a client that stalls (sends nothing for `idleMs`) or trickles
 * (still sending after `totalMs`) loses the connection instead of holding it, its socket and
 * the request open until Node's request timeout.
 */
export const DRAIN_TIMEOUTS = { idleMs: 5_000, totalMs: 30_000 } as const;

export interface DrainTimeouts {
  idleMs: number;
  totalMs: number;
}

/** `413 payload_too_large` naming the limit (`limitBytes`, which clients show). */
export const tooLarge = (maxBytes: number) =>
  new AppError(
    'payload_too_large',
    413,
    `The file exceeds the upload limit of ${formatMb(maxBytes)}.`,
    undefined,
    { limitBytes: maxBytes },
  );

/**
 * Reads and discards the rest of `source`, at most `budget` more bytes; constant memory.
 * True when it ended within the budget and the time bounds; otherwise the stream is destroyed
 * (the socket goes).
 */
function drain(
  source: Readable,
  budget: number,
  timeouts: DrainTimeouts = DRAIN_TIMEOUTS,
): Promise<boolean> {
  return new Promise((resolve) => {
    // A small body may have been read to its end before the limit was noticed.
    if (source.readableEnded) {
      resolve(true);
      return;
    }
    if (source.destroyed) {
      resolve(false);
      return;
    }
    let left = budget;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(() => finish(false), timeouts.totalMs);
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => finish(false), timeouts.idleMs);
    };
    let finished = false;
    const finish = (drained: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      clearTimeout(idle);
      source.off('data', onData);
      source.off('end', onEnd);
      source.off('error', onError);
      source.off('close', onClose);
      if (!drained) source.destroy();
      resolve(drained);
    };
    const onClose = () => finish(source.readableEnded);
    const onData = (chunk: Buffer) => {
      left -= chunk.length;
      if (left < 0) finish(false);
      else armIdle();
    };
    const onEnd = () => finish(true);
    const onError = () => finish(false);
    source.on('data', onData);
    source.once('end', onEnd);
    source.once('error', onError);
    source.once('close', onClose);
    armIdle();
    source.resume();
  });
}

function formatMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return Number.isInteger(mb) ? `${mb} MB` : `${Math.round(mb * 10) / 10} MB`;
}

const notMultipart = () =>
  new AppError(
    'unsupported_media_type',
    415,
    'Send the file as multipart/form-data in the field "file".',
  );

const noFile = (detail = 'Attach one file in the multipart field "file".') =>
  new AppError('validation_failed', 422, detail, [{ path: 'file', message: detail }]);

/**
 * Streams the multipart `file` field of an upload into a temp file (ADR 0049 §3.1): counted
 * while streaming and aborted above `maxBytes` with `413 payload_too_large`, so an oversized
 * body is never buffered or stored whole. A declared `Content-Length` that cannot fit is
 * refused without storing anything. Either way the rest of an oversized body is drained (up
 * to `DRAIN_EXTRA_BYTES` beyond the limit) before the `413`, which then closes the
 * connection. Other parts are discarded; a second file is ignored.
 */
export async function receiveFile(
  request: UploadRequest,
  options: {
    maxBytes: number;
    tmpDir: string;
    drainTimeouts?: DrainTimeouts;
    /**
     * Told of every file chunk before it is written (upload-slots.ts); a `413` it throws ends
     * the upload like an oversized file, any other error like a malformed body.
     */
    onFileBytes?: (n: number) => void;
  },
): Promise<ReceivedFile> {
  const contentType = request.contentType ?? '';
  if (!/^multipart\/form-data\s*;/i.test(contentType)) throw notMultipart();
  const rawMax = options.maxBytes + MULTIPART_OVERHEAD;
  const declared = request.contentLength === undefined ? Number.NaN : Number(request.contentLength);
  const drainCap = options.maxBytes + DRAIN_EXTRA_BYTES;
  if (Number.isFinite(declared) && declared > rawMax) {
    // Nothing is stored; the body is only read off the wire so the 413 arrives cleanly.
    if (request.body !== null && declared <= drainCap) {
      await drain(
        Readable.fromWeb(request.body as WebReadableStream<Uint8Array>),
        drainCap,
        options.drainTimeouts,
      );
    }
    throw tooLarge(options.maxBytes);
  }
  if (request.body === null) throw noFile();

  let parser: busboy.Busboy;
  try {
    parser = busboy({
      headers: { 'content-type': contentType },
      // Browsers send UTF-8 file names; busboy would read them as latin1.
      defParamCharset: 'utf8',
      preservePath: false,
      // +1: busboy flags a file that reaches the limit exactly, so a file of `maxBytes` fits.
      limits: {
        fileSize: options.maxBytes + 1,
        files: 1,
        fields: 20,
        fieldSize: 1024,
        parts: 25,
        headerPairs: 50,
      },
    });
  } catch {
    throw notMultipart();
  }

  const path = join(options.tmpDir, `${uuidv7()}.upload`);
  const source = Readable.fromWeb(request.body as WebReadableStream<Uint8Array>);
  let rawBytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      rawBytes += chunk.length;
      if (rawBytes > rawMax) done(tooLarge(options.maxBytes));
      else done(null, chunk);
    },
  });

  // Hoisted so a failure can stop the file's streams and wait for them before removing the
  // temp file (an open still in flight would otherwise re-create it after the removal).
  let fileWritten: Promise<ReceivedFile | null> = Promise.resolve(null);
  const active: { destroy(error?: Error): void }[] = [];
  try {
    return await new Promise<ReceivedFile>((resolve, reject) => {
      let settled = false;
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        // Stop parsing and writing at once; the request itself is detached from the parser.
        source.unpipe(counter);
        counter.destroy();
        parser.destroy();
        for (const stream of active) stream.destroy();
        const error = err instanceof AppError ? err : noFile('The multipart body is malformed.');
        if (error.status !== 413) {
          source.destroy();
          reject(error);
          return;
        }
        // Oversized: the partial file goes now, not after the drain; then the rest of the body is
        // read off the wire (discarded) so the 413 reaches the client.
        void fileWritten
          .catch(() => null)
          .then(() => rm(path, { force: true }))
          .catch(() => {});
        void drain(source, drainCap - rawBytes, options.drainTimeouts).then(() => reject(error));
      };
      parser.on('file', (name, file, info) => {
        if (name !== 'file' || settled) {
          file.resume();
          return;
        }
        let size = 0;
        const count = new Transform({
          transform(chunk: Buffer, _enc, done) {
            size += chunk.length;
            if (size > options.maxBytes) {
              done(tooLarge(options.maxBytes));
              return;
            }
            try {
              options.onFileBytes?.(chunk.length);
            } catch (err) {
              done(err as Error);
              return;
            }
            done(null, chunk);
          },
        });
        file.on('limit', () => count.destroy(tooLarge(options.maxBytes)));
        const out = createWriteStream(path, { flags: 'wx', mode: 0o600 });
        active.push(file, count, out);
        fileWritten = pipeline(file, count, out).then(() => ({
          path,
          size,
          filename: info.filename ?? '',
          declaredType: info.mimeType ?? '',
        }));
        fileWritten.catch(fail);
      });
      parser.on('error', fail);
      parser.on('close', () => {
        fileWritten.then((received) => {
          if (settled) return;
          settled = true;
          if (received === null) reject(noFile());
          else resolve(received);
        }, fail);
      });
      // Not `pipeline`: an oversized body must stay readable for `drain` after the parser goes.
      source.on('error', fail);
      counter.on('error', fail);
      source.pipe(counter).pipe(parser);
    });
  } catch (err) {
    await fileWritten.catch(() => null);
    await rm(path, { force: true });
    throw err;
  }
}
