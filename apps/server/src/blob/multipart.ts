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

export const tooLarge = (maxBytes: number) =>
  new AppError(
    'payload_too_large',
    413,
    `The file exceeds the upload limit of ${formatMb(maxBytes)}.`,
  );

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
 * refused before anything is read. Other parts are discarded; a second file is ignored.
 */
export async function receiveFile(
  request: UploadRequest,
  options: { maxBytes: number; tmpDir: string },
): Promise<ReceivedFile> {
  const contentType = request.contentType ?? '';
  if (!/^multipart\/form-data\s*;/i.test(contentType)) throw notMultipart();
  const rawMax = options.maxBytes + MULTIPART_OVERHEAD;
  const declared = request.contentLength === undefined ? Number.NaN : Number(request.contentLength);
  if (Number.isFinite(declared) && declared > rawMax) throw tooLarge(options.maxBytes);
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
        // Stops reading the request: the rest of an oversized body is never pulled in.
        source.destroy();
        for (const stream of active) stream.destroy();
        reject(err instanceof AppError ? err : noFile('The multipart body is malformed.'));
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
            if (size > options.maxBytes) done(tooLarge(options.maxBytes));
            else done(null, chunk);
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
      pipeline(source, counter, parser).catch(fail);
    });
  } catch (err) {
    await fileWritten.catch(() => null);
    await rm(path, { force: true });
    throw err;
  }
}
