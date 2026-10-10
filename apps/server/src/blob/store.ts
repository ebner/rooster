import { constants } from 'node:fs';
import { copyFile, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import type { Config } from '../config.ts';
import { PRIVATE_DIR_MODE } from '../db/boot.ts';
import { assertBlobKey } from './keys.ts';
import { S3BlobStore, type S3Settings } from './s3-store.ts';

/** `attachment.storage` / `blob_gc.storage`: which backend holds a blob. */
export type StorageKind = 'local' | 's3';

/**
 * What `put` stores: a file on disk (an upload's temp file; the local store moves it into
 * place, so the caller must not rely on it afterwards) or bytes in memory (thumbnails, avatars).
 */
export type BlobBody = { file: string; size: number } | Buffer;

export interface BlobObject {
  stream: Readable;
  /** Bytes, when the backend knows it up front. */
  size: number | null;
}

/** Response overrides baked into a presigned download URL (ADR 0049 §3.5). */
export interface SignedUrlOptions {
  ttlSeconds: number;
  contentType: string;
  disposition: string;
}

/** 04 §4.8. Keys are validated against `keys.ts` by every implementation. */
export interface BlobStore {
  readonly kind: StorageKind;
  put(key: string, body: BlobBody, contentType: string): Promise<void>;
  /** The blob as a stream, or null when it does not exist. */
  get(key: string): Promise<BlobObject | null>;
  /** Idempotent: deleting a missing blob succeeds. */
  delete(key: string): Promise<void>;
  /** Present on stores that serve downloads themselves (S3): a short-lived GET URL. */
  signedUrl?(key: string, options: SignedUrlOptions): Promise<string>;
}

/**
 * The configured backends: new blobs go to `current` (S3 when `ROOSTER_S3_BUCKET` is set),
 * existing ones are read from the backend their row records, so switching the configuration
 * does not orphan older files (ADR 0049 §3.4).
 */
export interface BlobStores {
  current: BlobStore;
  byKind(kind: StorageKind): BlobStore | null;
}

export function blobStores(local: BlobStore, s3: BlobStore | null): BlobStores {
  return {
    current: s3 ?? local,
    byKind: (kind) => (kind === 'local' ? local : s3),
  };
}

/** `<dataDir>/attachments/<key>` (08 §2 data layout). */
export class LocalBlobStore implements BlobStore {
  readonly kind = 'local' as const;

  constructor(private readonly root: string) {}

  private pathOf(key: string): string {
    return join(this.root, assertBlobKey(key));
  }

  async put(key: string, body: BlobBody, _contentType: string): Promise<void> {
    const target = this.pathOf(key);
    await mkdir(dirname(target), { recursive: true, mode: PRIVATE_DIR_MODE });
    if (Buffer.isBuffer(body)) {
      // Written beside the target and renamed, so a reader never sees half a file.
      const part = `${target}.${process.pid}.${Date.now()}.part`;
      try {
        await writeFile(part, body, { mode: 0o600, flag: 'wx' });
        await rename(part, target);
      } finally {
        await rm(part, { force: true });
      }
      return;
    }
    try {
      await rename(body.file, target);
    } catch (err) {
      // The temp directory sits on another filesystem than the attachments.
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      const part = `${target}.${process.pid}.${Date.now()}.part`;
      try {
        await copyFile(body.file, part, constants.COPYFILE_EXCL);
        await rename(part, target);
      } finally {
        await rm(part, { force: true });
      }
    }
  }

  async get(key: string): Promise<BlobObject | null> {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(this.pathOf(key), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ELOOP') return null;
      throw err;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        await handle.close();
        return null;
      }
      return { stream: handle.createReadStream(), size: stat.size };
    } catch (err) {
      await handle.close();
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }
}

/** The stores from the configuration; S3 only with `ROOSTER_S3_BUCKET` (and its keys). */
export function createBlobStores(
  config: Pick<Config, 'dataDir' | 's3'>,
  s3Client?: S3Settings['client'],
): BlobStores {
  const local = new LocalBlobStore(join(config.dataDir, 'attachments'));
  const s3 = config.s3 === null ? null : new S3BlobStore({ ...config.s3, client: s3Client });
  return blobStores(local, s3);
}
