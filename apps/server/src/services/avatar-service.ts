import { mkdir, rm } from 'node:fs/promises';
import { uuidv7 } from '@rooster/core/ids';
import { AVATAR_MAX_BYTES } from '@rooster/core/limits';
import type { Me } from '@rooster/core/schemas';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { KeyedLock } from '../auth/keyed-lock.ts';
import { avatarImage, isMimeMismatch, RASTER_TYPES, sniffFile } from '../blob/content.ts';
import { avatarKey } from '../blob/keys.ts';
import { receiveFile, type UploadRequest, uploadTmpDir } from '../blob/multipart.ts';
import type { BlobObject, BlobStores, StorageKind } from '../blob/store.ts';
import { UploadSlots } from '../blob/upload-slots.ts';
import { PRIVATE_DIR_MODE } from '../db/boot.ts';
import { blobGc, member, organization, user } from '../db/schema/index.ts';
import type { Audience } from '../events/bus.ts';
import { AppError } from '../lib/errors.ts';
import { matchesEtag } from '../lib/etag.ts';
import { logSafeError } from '../lib/log-safe-error.ts';
import {
  type Actor,
  emitAfterCommit,
  immediate,
  readOnly,
  type ServiceDeps,
  type Tx,
} from './context.ts';
import { memberIds, qk, selfAudience } from './event-audience.ts';
import { grantReachesOrg, requireBrowserSession } from './grant-access.ts';
import { listMemberships } from './org-access.ts';
import type { UserService } from './user-service.ts';

export type AvatarDownload =
  | { kind: 'stream'; blob: BlobObject; etag: string }
  | { kind: 'not-modified'; etag: string };

interface StoredAvatar {
  userId: string;
  avatarAt: number;
  /** Null: stored before per-upload keys, at the shared key. */
  storage: StorageKind | null;
  avatarId: string | null;
}

function storedAvatar(row: {
  id: string;
  avatarAt: number | null;
  avatarStorage: StorageKind | null;
  avatarId: string | null;
}): StoredAvatar | null {
  return row.avatarAt === null
    ? null
    : {
        userId: row.id,
        avatarAt: row.avatarAt,
        storage: row.avatarStorage,
        avatarId: row.avatarId,
      };
}

/**
 * The blob key of a stored avatar: its own id; the version for the few stored by an unreleased
 * build keyed by `avatar_at`; the shared key for avatars from before (no recorded backend).
 */
function keyOf(stored: StoredAvatar): string {
  if (stored.storage === null) return avatarKey(stored.userId);
  return avatarKey(stored.userId, stored.avatarId ?? stored.avatarAt);
}

/** Strong, and different for every upload even when the clock repeats `avatar_at`. */
function etagOf(stored: StoredAvatar): string {
  return stored.avatarId === null
    ? `"avatar-${stored.avatarAt}"`
    : `"avatar-${stored.avatarAt}-${stored.avatarId}"`;
}

const avatarNotFound = () => new AppError('not_found', 404, 'Avatar not found.');

/** `user.image` while an uploaded avatar is the picture; `v` busts caches on every upload. */
export function avatarUrl(userId: string, avatarAt: number): string {
  return `/api/v1/avatars/${userId}?v=${avatarAt}`;
}

/**
 * Uploaded avatars (FR-SET-1, ADR 0049 §3.7): a 256 × 256 WebP at BlobStore key
 * `avatars/<userId>`. While one is set, `user.image` points at it and the sign-in provider's
 * picture waits in `user.oidc_image`; DELETE restores that. Avatars are always served through
 * the server (never a presigned URL), so `<img>` caching works with the `?v=` URL.
 */
export class AvatarService {
  /** PUT and DELETE of one user's avatar run one at a time (same blob key). */
  private readonly locks = new KeyedLock();
  /** Uploads in flight per user (each holds a temp file). */
  private readonly uploads = new UploadSlots();

  constructor(
    private readonly deps: ServiceDeps,
    private readonly stores: BlobStores,
    private readonly users: UserService,
  ) {}

  private get tmpDir(): string {
    return uploadTmpDir(this.deps.config.dataDir);
  }

  /** PUT /me/avatar: a raster image of at most 2 MB (browser session only, like PATCH /me). */
  async put(actor: Actor, request: UploadRequest): Promise<Me> {
    requireBrowserSession(actor);
    const slot = this.uploads.acquire(actor.userId);
    let image: Buffer | null = null;
    try {
      await mkdir(this.tmpDir, { recursive: true, mode: PRIVATE_DIR_MODE });
      image = await this.decode(request);
    } finally {
      slot.release();
    }
    if (image === null) throw notAnImage();
    const avatar = image;
    // Serialised with DELETE per user. The key is the upload's own id, never reused, so the
    // blob GC can never reach a later avatar (keys of replaced ones are queued there).
    await this.locks.run(actor.userId, async () => {
      const avatarId = uuidv7();
      const store = this.stores.current;
      const key = avatarKey(actor.userId, avatarId);
      await store.put(key, avatar, 'image/webp');
      let previous: StoredAvatar | null;
      try {
        previous = this.recordUpload(actor, store.kind, avatarId);
      } catch (err) {
        await store.delete(key).catch(() => {});
        throw err;
      }
      await this.deleteLegacy(previous);
    });
    return this.users.getMe(actor);
  }

  /** The upload as a 256 px WebP, or null when it is not a raster image. */
  private async decode(request: UploadRequest): Promise<Buffer | null> {
    const file = await receiveFile(request, { maxBytes: AVATAR_MAX_BYTES, tmpDir: this.tmpDir });
    try {
      const sniffed = await sniffFile(file.path);
      if (isMimeMismatch(file.declaredType, file.filename, sniffed.mime)) {
        throw new AppError(
          'mime_mismatch',
          415,
          'The file is not the image its name or type claims; nothing was uploaded.',
        );
      }
      if (!RASTER_TYPES.has(sniffed.mime)) throw notAnImage();
      return await avatarImage(file.path);
    } finally {
      await rm(file.path, { force: true });
    }
  }

  /**
   * Points the user at the new upload and queues the replaced one for the blob GC (keys are
   * unique per upload, so a late GC run cannot hit a newer avatar). Returns the replaced one.
   */
  private recordUpload(actor: Actor, storage: StorageKind, avatarId: string): StoredAvatar | null {
    return immediate(this.deps.db, (tx) => {
      const row = this.requireUser(tx, actor.userId);
      const previous = storedAvatar(row);
      this.queueForGc(tx, previous);
      // The version in the image URL (cache busting); the ETag also carries the id.
      const avatarAt = Math.max(this.deps.clock(), (row.avatarAt ?? 0) + 1);
      tx.update(user)
        .set({
          image: avatarUrl(actor.userId, avatarAt),
          avatarAt,
          avatarStorage: storage,
          avatarId,
          // The provider's picture is kept once, from before the first upload.
          oidcImage: row.avatarAt === null ? row.image : row.oidcImage,
          updatedAt: new Date(this.deps.clock()),
        })
        .where(eq(user.id, actor.userId))
        .run();
      this.emit(tx, actor.userId);
      return previous;
    });
  }

  /** A generation-keyed avatar goes through `blob_gc`, which retries an unreachable backend. */
  private queueForGc(tx: Tx, stored: StoredAvatar | null): void {
    if (stored === null || stored.storage === null) return;
    tx.insert(blobGc)
      .values({
        key: keyOf(stored),
        storage: stored.storage,
        queuedAt: this.deps.clock(),
      })
      .onConflictDoNothing()
      .run();
  }

  /**
   * An avatar from before generation keys (`avatar_storage` null) sits at the shared key in
   * either backend. Nothing writes that key any more, so deleting it late cannot hit a newer
   * avatar. A failed delete is logged; such an object is never read for a later upload.
   */
  private async deleteLegacy(stored: StoredAvatar | null): Promise<void> {
    if (stored === null || stored.storage !== null) return;
    const key = avatarKey(stored.userId);
    for (const kind of ['local', 's3'] as const) {
      await this.stores
        .byKind(kind)
        ?.delete(key)
        .catch((err: unknown) =>
          this.deps.logger.warn({ err: logSafeError(err) }, 'avatar blob delete failed'),
        );
    }
  }

  /** DELETE /me/avatar: back to the sign-in provider's picture. A no-op without an upload. */
  async remove(actor: Actor): Promise<Me> {
    requireBrowserSession(actor);
    await this.locks.run(actor.userId, () => this.removeUpload(actor));
    return this.users.getMe(actor);
  }

  private async removeUpload(actor: Actor): Promise<void> {
    const removed = immediate(this.deps.db, (tx) => {
      const row = this.requireUser(tx, actor.userId);
      const stored = storedAvatar(row);
      if (stored === null) return null;
      this.queueForGc(tx, stored);
      tx.update(user)
        .set({
          image: row.oidcImage,
          avatarAt: null,
          avatarStorage: null,
          avatarId: null,
          oidcImage: null,
          updatedAt: new Date(this.deps.clock()),
        })
        .where(eq(user.id, actor.userId))
        .run();
      this.emit(tx, actor.userId);
      return stored;
    });
    await this.deleteLegacy(removed);
  }

  /**
   * GET /avatars/:userId: for users who share a live org with that user (themselves
   * included; a grant only through the orgs it reaches), otherwise `404`.
   */
  async get(actor: Actor, userId: string, ifNoneMatch?: string): Promise<AvatarDownload> {
    const current = readOnly(this.deps.db, (tx) => {
      const row = tx
        .select({
          id: user.id,
          avatarAt: user.avatarAt,
          avatarStorage: user.avatarStorage,
          avatarId: user.avatarId,
        })
        .from(user)
        .where(eq(user.id, userId))
        .get();
      if (row === undefined) return null;
      return userId === actor.userId || this.sharesOrg(tx, actor, userId)
        ? storedAvatar(row)
        : null;
    });
    if (current === null) throw avatarNotFound();
    // Only answered after the access check.
    const etag = etagOf(current);
    if (matchesEtag(ifNoneMatch, etag)) return { kind: 'not-modified', etag };
    const blob = await this.readBlob(current);
    if (blob === null) throw avatarNotFound();
    return { kind: 'stream', blob, etag };
  }

  /**
   * This upload's own object (its key, in its backend), or null: a stale copy left in a
   * backend or bucket that was not configured when the avatar was replaced or removed has
   * another key and is never served. Avatars from before per-upload keys (`avatar_storage`
   * null) are looked up at the shared key, in the current backend first, then the other one.
   */
  private async readBlob(stored: StoredAvatar): Promise<BlobObject | null> {
    const key = keyOf(stored);
    if (stored.storage !== null) {
      return (await this.stores.byKind(stored.storage)?.get(key)) ?? null;
    }
    const current = this.stores.current;
    const other = this.stores.byKind(current.kind === 'local' ? 's3' : 'local');
    return (await current.get(key)) ?? (await other?.get(key)) ?? null;
  }

  /**
   * Sign-in never overwrites an uploaded avatar (ADR 0049 §3.7). better-auth does not update
   * the picture of an existing user today (`overrideUserInfoOnSignIn` and `updateUserInfoOnLink`
   * are off); should a provider profile reach `user.image` anyway, it becomes the new
   * `oidc_image` and the upload stays. Called from the auth `user.update.after` hook.
   */
  keepUploaded(userId: string): void {
    // One statement, no transaction: better-auth may call its hooks inside its own.
    const expected = sql`'/api/v1/avatars/' || ${user.id} || '?v=' || ${user.avatarAt}`;
    this.deps.db.orm
      .update(user)
      .set({ oidcImage: sql`${user.image}`, image: expected })
      .where(
        and(eq(user.id, userId), isNotNull(user.avatarAt), sql`${user.image} IS NOT ${expected}`),
      )
      .run();
  }

  private sharesOrg(tx: Tx, actor: Actor, userId: string): boolean {
    const mine = member;
    const theirs = alias(member, 'theirs');
    const shared = tx
      .select({ orgId: mine.organizationId })
      .from(mine)
      .innerJoin(theirs, eq(theirs.organizationId, mine.organizationId))
      .innerJoin(organization, eq(organization.id, mine.organizationId))
      .where(
        and(
          eq(mine.userId, actor.userId),
          eq(theirs.userId, userId),
          isNull(organization.deletedAt),
        ),
      )
      .all();
    return shared.some((r) => grantReachesOrg(actor, r.orgId));
  }

  private requireUser(tx: Tx, userId: string) {
    const row = tx.select().from(user).where(eq(user.id, userId)).get();
    if (row === undefined) throw new AppError('not_found', 404, 'User not found.');
    return row;
  }

  /** `['me']` to the user, and every member list they appear in (like a new name). */
  private emit(tx: Tx, userId: string): void {
    const audiences: Audience[] = [
      selfAudience(userId, null, [qk.me]),
      ...listMemberships(tx, userId).map((m) => ({
        org: m.org.id,
        userIds: memberIds(tx, m.org.id),
        keys: [qk.orgMembers(m.org.id), qk.everyone(m.org.id)],
      })),
    ];
    emitAfterCommit(this.deps, tx, {
      type: 'user.updated',
      orgId: null,
      actorId: userId,
      subjects: [userId],
      audiences,
    });
  }
}

const notAnImage = () =>
  new AppError(
    'unsupported_media_type',
    415,
    'Upload a PNG, JPEG, GIF, WebP or AVIF image as the avatar.',
  );
