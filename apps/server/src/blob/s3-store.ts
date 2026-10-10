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
}

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
        });
      return { client, mod };
    });
    return this.sdk;
  }

  async put(key: string, body: BlobBody, contentType: string): Promise<void> {
    const { client, mod } = await this.load();
    const isBuffer = Buffer.isBuffer(body);
    await client.send(
      new mod.PutObjectCommand({
        Bucket: this.settings.bucket,
        Key: assertBlobKey(key),
        Body: isBuffer ? body : createReadStream(body.file),
        ContentLength: isBuffer ? body.length : body.size,
        ContentType: contentType,
      }),
    );
  }

  async get(key: string): Promise<BlobObject | null> {
    const { client, mod } = await this.load();
    try {
      const out = await client.send(
        new mod.GetObjectCommand({ Bucket: this.settings.bucket, Key: assertBlobKey(key) }),
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
    await client.send(
      new mod.DeleteObjectCommand({ Bucket: this.settings.bucket, Key: assertBlobKey(key) }),
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
      ResponseCacheControl: 'private, max-age=60',
    });
    return getSignedUrl(client, command, { expiresIn: options.ttlSeconds });
  }
}
