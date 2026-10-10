import { mkdir, rm } from 'node:fs/promises';
import { AVATAR_MAX_BYTES } from '@rooster/core/limits';
import type { Me } from '@rooster/core/schemas';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { KeyedLock } from '../auth/keyed-lock.ts';
import { avatarImage, isMimeMismatch, RASTER_TYPES, sniffFile } from '../blob/content.ts';
import { avatarKey } from '../blob/keys.ts';
import { receiveFile, type UploadRequest, uploadTmpDir } from '../blob/multipart.ts';
import type { BlobObject, BlobStores } from '../blob/store.ts';
import { PRIVATE_DIR_MODE } from '../db/boot.ts';
import { member, organization, user } from '../db/schema/index.ts';
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
    await mkdir(this.tmpDir, { recursive: true, mode: PRIVATE_DIR_MODE });
    const file = await receiveFile(request, { maxBytes: AVATAR_MAX_BYTES, tmpDir: this.tmpDir });
    let image: Buffer | null = null;
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
      image = await avatarImage(file.path);
    } finally {
      await rm(file.path, { force: true });
    }
    if (image === null) throw notAnImage();
    const avatar = image;
    // Serialised with DELETE per user: a removal's blob delete must not hit this upload's blob.
    await this.locks.run(actor.userId, async () => {
      await this.stores.current.put(avatarKey(actor.userId), avatar, 'image/webp');
      this.recordUpload(actor);
    });
    return this.users.getMe(actor);
  }

  private recordUpload(actor: Actor): void {
    immediate(this.deps.db, (tx) => {
      const row = this.requireUser(tx, actor.userId);
      const avatarAt = Math.max(this.deps.clock(), (row.avatarAt ?? 0) + 1);
      tx.update(user)
        .set({
          image: avatarUrl(actor.userId, avatarAt),
          avatarAt,
          // The provider's picture is kept once, from before the first upload.
          oidcImage: row.avatarAt === null ? row.image : row.oidcImage,
          updatedAt: new Date(this.deps.clock()),
        })
        .where(eq(user.id, actor.userId))
        .run();
      this.emit(tx, actor.userId);
    });
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
      if (row.avatarAt === null) return false;
      tx.update(user)
        .set({
          image: row.oidcImage,
          avatarAt: null,
          oidcImage: null,
          updatedAt: new Date(this.deps.clock()),
        })
        .where(eq(user.id, actor.userId))
        .run();
      this.emit(tx, actor.userId);
      return true;
    });
    if (removed) {
      // Not queued in blob_gc: the key is reused by the next upload, which a late GC run
      // would otherwise delete. A failed delete leaves a blob the next upload overwrites.
      const key = avatarKey(actor.userId);
      for (const kind of ['local', 's3'] as const) {
        await this.stores
          .byKind(kind)
          ?.delete(key)
          .catch((err: unknown) =>
            this.deps.logger.warn({ err: logSafeError(err) }, 'avatar blob delete failed'),
          );
      }
    }
  }

  /**
   * GET /avatars/:userId: for users who share a live org with that user (themselves
   * included; a grant only through the orgs it reaches), otherwise `404`.
   */
  async get(actor: Actor, userId: string, ifNoneMatch?: string): Promise<AvatarDownload> {
    const avatarAt = readOnly(this.deps.db, (tx) => {
      const row = tx
        .select({ avatarAt: user.avatarAt })
        .from(user)
        .where(eq(user.id, userId))
        .get();
      if (row === undefined || row.avatarAt === null) return null;
      return userId === actor.userId || this.sharesOrg(tx, actor, userId) ? row.avatarAt : null;
    });
    if (avatarAt === null) throw avatarNotFound();
    // Strong: each upload has its own `avatar_at`. Only answered after the access check.
    const etag = `"avatar-${avatarAt}"`;
    if (matchesEtag(ifNoneMatch, etag)) return { kind: 'not-modified', etag };
    const key = avatarKey(userId);
    // The current backend first; the other one holds avatars from before a storage switch.
    const current = this.stores.current;
    const other = this.stores.byKind(current.kind === 'local' ? 's3' : 'local');
    const blob = (await current.get(key)) ?? (await other?.get(key)) ?? null;
    if (blob === null) throw avatarNotFound();
    return { kind: 'stream', blob, etag };
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
