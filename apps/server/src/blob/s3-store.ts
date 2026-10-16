import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import type { S3Client } from '@aws-sdk/client-s3';
import { assertBlobKey } from './keys.ts';
import type { BlobBody, BlobObject, BlobStore, SignedUrlOptions } from './store.ts';

export interface S3Settings {
  bucket: string;
  /** `ROOSTER_S3_ENDPOINT`; null for AWS itself. The only host the store ever talks to (SSRF). */
  endpoint: string | null;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  /** Tests inject a client whose `send` is a fake (presigning needs no network). */
  client?: S3Client | undefined;
  /** `S3_TIMEOUT_MS` unless set (tests). */
  timeoutMs?: number | undefined;
}

/**
 * Deadline of one S3 request (for a download: until the response headers arrive). A stalled
 * backend fails the request instead of holding it, its locks and its memory indefinitely.
 */
export const S3_TIMEOUT_MS = 30_000;
/** On top of the deadline, an upload gets this long per byte (at least 64 KiB/s). */
const UPLOAD_MS_PER_BYTE = 1000 / (64 * 1024);
/** A connection that sends or receives nothing for this long is dropped (bodies included). */
const S3_IDLE_TIMEOUT_MS = 30_000;
const S3_CONNECT_TIMEOUT_MS = 10_000;

type Sdk = typeof import('@aws-sdk/client-s3');

/**
 * S3-compatible storage (04 §4.8): the same keys as the local store, in the configured bucket.
 * The SDK is loaded on first use, so instances without S3 never pay for it at boot.
 */
export class S3BlobStore implements BlobStore {
  readonly kind = 's3' as const;
  private sdk: Promise<{ client: S3Client; mod: Sdk }> | undefined;

  constructor(private readonly settings: S3Settings) {}

  private load(): Promise<{ client: S3Client; mod: Sdk }> {
    this.sdk ??= import('@aws-sdk/client-s3').then((mod) => {
      const s = this.settings;
      const client =
        s.client ??
        new mod.S3Client({
          region: s.region,
          ...(s.endpoint === null ? {} : { endpoint: s.endpoint }),
          forcePathStyle: s.forcePathStyle,
          credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey },
          // S3-compatible stores (MinIO, R2, Garage) reject the newer default checksums.
          requestChecksumCalculation: 'WHEN_REQUIRED',
          responseChecksumValidation: 'WHEN_REQUIRED',
          requestHandler: {
            connectionTimeout: S3_CONNECT_TIMEOUT_MS,
            socketTimeout: S3_IDLE_TIMEOUT_MS,
          },
        });
      return { client, mod };
    });
    return this.sdk;
  }

  /**
   * Runs one request under a deadline: the SDK aborts it (and its socket) when the signal
   * fires. The timer stops once the response is there, so a download's body is bounded by the
   * idle timeout only and a slow but moving download is not cut.
   */
  private async withDeadline<T>(
    ms: number,
    run: (abortSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`S3 request timed out after ${ms} ms`)),
      ms,
    );
    timer.unref?.();
    try {
      return await run(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  private get timeoutMs(): number {
    return this.settings.timeoutMs ?? S3_TIMEOUT_MS;
  }

  async put(key: string, body: BlobBody, contentType: string): Promise<void> {
    const { client, mod } = await this.load();
    const isBuffer = Buffer.isBuffer(body);
    const size = isBuffer ? body.length : body.size;
    // Closed here whatever happens: a PUT refused before `100 Continue` never reads it, and
    // the SDK leaves it (and its descriptor) open.
    const source = Buffer.isBuffer(body) ? null : createReadStream(body.file);
    // The file opens asynchronously. When S3 refuses the PUT before that open completes, the
    // caller may already have deleted the file; the late ENOENT must not become an uncaught
    // exception (it would end the process). The PUT's own failure is reported by the SDK.
    source?.on('error', () => {});
    try {
      await this.withDeadline(
        this.timeoutMs + Math.ceil(size * UPLOAD_MS_PER_BYTE),
        (abortSignal) =>
          client.send(
            new mod.PutObjectCommand({
              Bucket: this.settings.bucket,
              Key: assertBlobKey(key),
              Body: source ?? (body as Buffer),
              ContentLength: size,
              ContentType: contentType,
            }),
            { abortSignal },
          ),
      );
    } finally {
      source?.destroy();
    }
  }

  async get(key: string): Promise<BlobObject | null> {
    const { client, mod } = await this.load();
    try {
      const out = await this.withDeadline(this.timeoutMs, (abortSignal) =>
        client.send(
          new mod.GetObjectCommand({ Bucket: this.settings.bucket, Key: assertBlobKey(key) }),
          { abortSignal },
        ),
      );
      if (out.Body === undefined) return null;
      return { stream: out.Body as Readable, size: out.ContentLength ?? null };
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const { client, mod } = await this.load();
    await this.withDeadline(this.timeoutMs, (abortSignal) =>
      client.send(
        new mod.DeleteObjectCommand({ Bucket: this.settings.bucket, Key: assertBlobKey(key) }),
        { abortSignal },
      ),
    );
  }

  async signedUrl(key: string, options: SignedUrlOptions): Promise<string> {
    const { client, mod } = await this.load();
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const command = new mod.GetObjectCommand({
      Bucket: this.settings.bucket,
      Key: assertBlobKey(key),
      ResponseContentType: options.contentType,
      ResponseContentDisposition: options.disposition,
      // Never reusable from a cache: the browser may be shared after sign-out.
      ResponseCacheControl: 'private, no-store',
    });
    return getSignedUrl(client, command, { expiresIn: options.ttlSeconds });
  }
}
