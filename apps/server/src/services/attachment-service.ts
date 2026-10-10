import { mkdir, rm } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { uuidv7 } from '@rooster/core/ids';
import { ATTACHMENTS_PER_TASK_MAX } from '@rooster/core/limits';
import type { Attachment } from '@rooster/core/schemas';
import { and, eq, isNull } from 'drizzle-orm';
import {
  cleanFilename,
  imageInfo,
  isMimeMismatch,
  RASTER_TYPES,
  sniffFile,
} from '../blob/content.ts';
import type { BlobGc } from '../blob/gc.ts';
import { attachmentKey, thumbKey } from '../blob/keys.ts';
import {
  type ReceivedFile,
  receiveFile,
  type UploadRequest,
  uploadTmpDir,
} from '../blob/multipart.ts';
import type { BlobStore, BlobStores } from '../blob/store.ts';
import { PRIVATE_DIR_MODE } from '../db/boot.ts';
import { attachment, blobGc } from '../db/schema/index.ts';
import { AppError } from '../lib/errors.ts';
import type { ActivityService } from './activity-service.ts';
import { viaFor } from './activity-service.ts';
import { type AttachmentRow, attachmentCounts, toAttachmentDto } from './attachment-queries.ts';
import {
  type Actor,
  afterCommit,
  emitAfterCommit,
  immediate,
  type OpMeta,
  readOnly,
  type ServiceDeps,
  type Tx,
} from './context.ts';
import { taskAudiences, taskReach } from './event-audience.ts';
import { authorizeTaskRead, authorizeTaskWrite, canReadTask } from './grant-access.ts';
import { requireTask, type TaskRow, taskDeleted } from './list-access.ts';

/** Presigned S3 download URLs live this long (ADR 0049 §3.5). */
export const SIGNED_URL_TTL_S = 60;

const attachmentNotFound = () => new AppError('not_found', 404, 'Attachment not found.');

/** What a download route sends: the bytes, or a redirect to a presigned URL (S3). */
export type AttachmentDownload =
  | {
      kind: 'stream';
      stream: Readable;
      size: number | null;
      contentType: string;
      disposition: string;
    }
  | { kind: 'redirect'; url: string };

/** `Content-Type` of a stored type: sniffed text is known to be UTF-8. */
export function contentTypeOf(mime: string): string {
  return mime === 'text/plain' ? 'text/plain; charset=utf-8' : mime;
}

/**
 * `Content-Disposition` with an ASCII fallback and the RFC 5987 UTF-8 name, so a download
 * keeps its name in every browser and no header injection is possible.
 */
export function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Task attachments (FR-ATT, ADR 0049 §3). Uploading is an edit of the task (the
 * `tasks:write` capability and the grant's group constraint); downloading needs read access,
 * else `404`; deleting is for the uploader or the task's assignee (`403` for other members).
 * Blobs are written before the row, and removed through the `blob_gc` queue.
 */
export class AttachmentService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly stores: BlobStores,
    private readonly gc: BlobGc,
    private readonly activity: ActivityService,
  ) {}

  /** `ROOSTER_UPLOAD_MAX_MB` in bytes. */
  get maxBytes(): number {
    return this.deps.config.uploadMaxMb * 1024 * 1024;
  }

  /** `<dataDir>/tmp`: uploads in flight; boot clears it. */
  get tmpDir(): string {
    return uploadTmpDir(this.deps.config.dataDir);
  }

  /**
   * POST /tasks/:id/attachments. Access is checked before a byte is read, and again in the
   * transaction that records the attachment (the task may have changed meanwhile).
   */
  async upload(
    actor: Actor,
    taskId: string,
    request: UploadRequest,
    meta?: OpMeta,
  ): Promise<Attachment> {
    const orgId = readOnly(this.deps.db, (tx) => this.writableTask(tx, actor, taskId).orgId);
    await mkdir(this.tmpDir, { recursive: true, mode: PRIVATE_DIR_MODE });
    const file = await receiveFile(request, { maxBytes: this.maxBytes, tmpDir: this.tmpDir });
    const store = this.stores.current;
    const written: string[] = [];
    let recorded = false;
    try {
      const row = await this.prepare(file, orgId, store, written);
      const saved = immediate(this.deps.db, (tx) => {
        const target = this.writableTask(tx, actor, taskId);
        if (target.orgId !== orgId) throw new AppError('not_found', 404, 'Task not found.');
        tx.insert(attachment)
          .values({ ...row, taskId: target.id, uploaderId: actor.userId })
          .run();
        this.activity.record(
          tx,
          target,
          { actorId: actor.userId, via: viaFor(actor, meta), grantId: actor.grant?.id ?? null },
          { type: 'attachment_added', data: { attachmentId: row.id, filename: row.filename } },
        );
        this.emit(tx, actor, target, true);
        return { ...row, taskId: target.id, uploaderId: actor.userId };
      });
      recorded = true;
      return toAttachmentDto(saved);
    } finally {
      await rm(file.path, { force: true });
      if (!recorded && written.length > 0) this.discard(written, store.kind);
    }
  }

  /** Sniffs, checks and stores the upload's blobs; the row to insert (without task and uploader). */
  private async prepare(
    file: ReceivedFile,
    orgId: string,
    store: BlobStore,
    written: string[],
  ): Promise<Omit<AttachmentRow, 'taskId' | 'uploaderId'>> {
    const sniffed = await sniffFile(file.path);
    const raster = RASTER_TYPES.has(sniffed.mime);
    if (isMimeMismatch(file.declaredType, file.filename, sniffed.mime)) {
      throw new AppError(
        'mime_mismatch',
        415,
        'The file is not the image its name or type claims; nothing was uploaded.',
      );
    }
    const image = raster ? await imageInfo(file.path) : null;
    const id = uuidv7();
    const key = attachmentKey(orgId, id);
    await store.put(key, { file: file.path, size: file.size }, sniffed.mime);
    written.push(key);
    let thumb: string | null = null;
    if (image?.thumb != null) {
      thumb = thumbKey(orgId, id);
      await store.put(thumb, image.thumb, 'image/webp');
      written.push(thumb);
    }
    return {
      id,
      orgId,
      filename: cleanFilename(file.filename, sniffed.ext),
      mime: sniffed.mime,
      size: file.size,
      storage: store.kind,
      key,
      thumbKey: thumb,
      width: image?.width ?? null,
      height: image?.height ?? null,
      createdAt: this.deps.clock(),
      deletedAt: null,
    };
  }

  /** Blobs of an upload that was not recorded go through the GC queue, like any other. */
  private discard(keys: readonly string[], storage: AttachmentRow['storage']): void {
    const now = this.deps.clock();
    for (const key of keys) {
      this.deps.db.orm
        .insert(blobGc)
        .values({ key, storage, queuedAt: now })
        .onConflictDoNothing()
        .run();
    }
    this.gc.kick();
  }

  /** GET /attachments/:id (`thumb`: GET /attachments/:id/thumb). */
  async download(
    actor: Actor,
    attachmentId: string,
    options: { inline?: boolean; thumb?: boolean } = {},
  ): Promise<AttachmentDownload> {
    const row = readOnly(this.deps.db, (tx) => {
      const found = this.findLive(tx, attachmentId);
      const target = this.visibleTask(tx, actor, found.taskId);
      authorizeTaskRead(tx, actor, target);
      return found;
    });
    const key = options.thumb === true ? row.thumbKey : row.key;
    if (key === null) throw new AppError('not_found', 404, 'This attachment has no thumbnail.');
    const store = this.stores.byKind(row.storage);
    if (store === null) {
      this.deps.logger.warn(
        { attachmentId: row.id, storage: row.storage },
        'attachment storage backend not configured',
      );
      throw attachmentNotFound();
    }
    let contentType: string;
    let disposition: string;
    if (options.thumb === true) {
      contentType = 'image/webp';
      disposition = contentDisposition('inline', `${row.filename}.webp`);
    } else {
      const inline = options.inline === true && RASTER_TYPES.has(row.mime);
      contentType = contentTypeOf(row.mime);
      disposition = contentDisposition(inline ? 'inline' : 'attachment', row.filename);
    }
    if (store.signedUrl !== undefined) {
      const url = await store.signedUrl(key, {
        ttlSeconds: SIGNED_URL_TTL_S,
        contentType,
        disposition,
      });
      return { kind: 'redirect', url };
    }
    const blob = await store.get(key);
    if (blob === null) {
      this.deps.logger.warn({ attachmentId: row.id }, 'attachment blob missing');
      throw attachmentNotFound();
    }
    return { kind: 'stream', stream: blob.stream, size: blob.size, contentType, disposition };
  }

  /** DELETE /attachments/:id: the uploader or the task's assignee; no undo. */
  remove(actor: Actor, attachmentId: string, _meta?: OpMeta): void {
    immediate(this.deps.db, (tx) => {
      const row = this.findLive(tx, attachmentId);
      const target = this.visibleTask(tx, actor, row.taskId);
      authorizeTaskWrite(tx, actor, target, 'tasks:write');
      if (row.uploaderId !== actor.userId && target.assigneeId !== actor.userId) {
        throw new AppError(
          'forbidden',
          403,
          'Only the person who attached the file or the task’s assignee can delete it.',
        );
      }
      if (target.deletedAt !== null) throw taskDeleted();
      // The attachment_blob_gc trigger queues the blobs; the GC deletes them after commit.
      tx.delete(attachment).where(eq(attachment.id, row.id)).run();
      this.emit(tx, actor, target, false);
      afterCommit(tx, () => this.gc.kick());
    });
  }

  private findLive(tx: Tx, attachmentId: string): AttachmentRow {
    const row = tx
      .select()
      .from(attachment)
      .where(and(eq(attachment.id, attachmentId), isNull(attachment.deletedAt)))
      .get();
    if (row === undefined) throw attachmentNotFound();
    return row;
  }

  /** The attachment's task, if the actor can see it; otherwise the attachment does not exist. */
  private visibleTask(tx: Tx, actor: Actor, taskId: string): TaskRow {
    let target: TaskRow;
    try {
      target = requireTask(tx, actor.userId, taskId);
    } catch (err) {
      if (err instanceof AppError && err.status === 404) throw attachmentNotFound();
      throw err;
    }
    if (!canReadTask(tx, actor, target)) throw attachmentNotFound();
    return target;
  }

  /** A live task the actor may edit, with room for another attachment. */
  private writableTask(tx: Tx, actor: Actor, taskId: string): TaskRow {
    const target = requireTask(tx, actor.userId, taskId);
    authorizeTaskWrite(tx, actor, target, 'tasks:write');
    if (target.deletedAt !== null) throw taskDeleted();
    if ((attachmentCounts(tx, [target.id]).get(target.id) ?? 0) >= ATTACHMENTS_PER_TASK_MAX) {
      throw new AppError(
        'too_many_attachments',
        409,
        `A task can have at most ${ATTACHMENTS_PER_TASK_MAX} attachments.`,
      );
    }
    return target;
  }

  /**
   * The task's detail and attachment count changed (and with `activity`, its feed): the same
   * audiences as a comment (`['task', id]` and family, `['my-list', org]`, `['everyone', org]`).
   */
  private emit(tx: Tx, actor: Actor, target: TaskRow, activity: boolean): void {
    emitAfterCommit(this.deps, tx, {
      type: 'task.updated',
      orgId: target.orgId,
      actorId: actor.userId,
      subjects: [target.id],
      audiences: taskAudiences(tx, {
        orgId: target.orgId,
        actorId: actor.userId,
        reach: taskReach(tx, [target.id]),
        ...(activity ? { activity: [target.id] } : {}),
      }),
    });
  }
}
