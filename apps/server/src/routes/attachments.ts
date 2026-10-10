import { Readable } from 'node:stream';
import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import { attachmentSchema } from '@rooster/core/schemas';
import type { Context } from 'hono';
import type { UploadRequest } from '../blob/multipart.ts';
import type { AppEnv } from '../lib/context.ts';
import { AppError } from '../lib/errors.ts';
import { named } from '../lib/openapi.ts';
import type { AttachmentDownload } from '../services/attachment-service.ts';
import type { Services } from '../services/index.ts';
import { AUTHED, actorOf, idParam, json, metaOf, problems } from './common.ts';

export const AttachmentSchema = named(attachmentSchema, 'Attachment');

/**
 * Download responses (ADR 0049 §3.5): the bytes may be anything a user attached, so the
 * browser must never interpret them as part of the app.
 */
export const DOWNLOAD_CSP = "default-src 'none'; sandbox";

/** The request as the upload services stream it (never buffered, never parsed by zod). */
export function uploadRequestOf(c: Context<AppEnv>): UploadRequest {
  return {
    contentType: c.req.header('content-type'),
    contentLength: c.req.header('content-length'),
    body: c.req.raw.body,
  };
}

/**
 * Runs an upload; a `413` also closes the connection (`Connection: close`), so nothing of an
 * oversized body (drained up to a cap) is read as the next request.
 */
export async function closingOnTooLarge<T>(
  c: Context<AppEnv>,
  upload: () => Promise<T>,
): Promise<T> {
  try {
    return await upload();
  } catch (err) {
    if (err instanceof AppError && err.status === 413) c.header('Connection', 'close');
    throw err;
  }
}

/**
 * A multipart body with one `file` part. A plain JSON-schema object, not zod: zod-openapi would
 * otherwise parse (and buffer) the whole form before the handler streams it.
 */
export function multipartFile(description: string) {
  return {
    required: true,
    description,
    content: {
      'multipart/form-data': {
        schema: {
          type: 'object' as const,
          properties: { file: { type: 'string' as const, format: 'binary', description } },
          required: ['file'],
        },
      },
    },
  };
}

type HeaderDocs = Record<
  string,
  { description: string; schema: { type: 'string' }; required?: boolean }
>;

/** A binary download of any (or the given) media type. */
export function binary(description: string, types: string[], headers: HeaderDocs) {
  return {
    description,
    headers,
    content: Object.fromEntries(
      types.map((type) => [type, { schema: { type: 'string' as const, format: 'binary' } }]),
    ),
  };
}

const DOWNLOAD_HEADERS: HeaderDocs = {
  'Content-Disposition': {
    description:
      '`attachment` (or `inline` for `?inline=1` on a raster image), with an ASCII `filename` and the RFC 5987 `filename*`.',
    schema: { type: 'string' },
    required: true,
  },
  'Cache-Control': {
    description: '`private, no-cache`: cached copies are revalidated on every use.',
    schema: { type: 'string' },
  },
  ETag: {
    description: 'Strong; send it as `If-None-Match` for a `304`.',
    schema: { type: 'string' },
  },
};

const NOT_MODIFIED = {
  description:
    'Not modified: `If-None-Match` matched the `ETag` (answered only after the access check).',
  headers: {
    ETag: { description: 'The current ETag', schema: { type: 'string' as const } },
  },
};

const REDIRECT: { description: string; headers: HeaderDocs } = {
  description:
    'S3 storage: a redirect to a presigned URL valid for 60 seconds, carrying the same type and disposition.',
  headers: {
    Location: { description: 'The presigned URL', schema: { type: 'string' }, required: true },
  },
};

const attachmentParams = z.object({ id: idParam('id', 'Attachment ID') });

/** 413 and 415 read differently for uploads than for JSON bodies. */
export function uploadProblems(limit: string, ...items: Parameters<typeof problems>) {
  const out = problems(...items);
  const tooLarge = out[413];
  if (tooLarge !== undefined) {
    const quota = items.includes('storage_quota_exceeded')
      ? ', or it would take the uploader past their storage quota (`ROOSTER_USER_STORAGE_MB`)'
      : '';
    out[413] = { ...tooLarge, description: `The file exceeds ${limit}${quota}` };
  }
  const unsupported = out[415];
  if (unsupported !== undefined) {
    out[415] = {
      ...unsupported,
      description:
        'Not multipart/form-data, or a file that claims to be an image (by type or extension) but is not one',
    };
  }
  return out;
}

const uploadAttachment = createRoute({
  method: 'post',
  path: '/api/v1/tasks/{id}/attachments',
  tags: ['attachments'],
  operationId: 'uploadAttachment',
  summary: 'Attach a file to a task (multipart, online only)',
  description:
    'One multipart part named `file`, streamed to storage; above `ROOSTER_UPLOAD_MAX_MB` (default 25 MB) the upload is cut off with `413`. Needs the same access as editing the task. The stored type is sniffed from the content, never taken from the client: a file that claims to be a PNG, JPEG, GIF, WebP or AVIF image but is not one is `415 mime_mismatch`. Such images get their size and a 320 px WebP thumbnail. At most 100 attachments per task (`409 too_many_attachments`). The attachments a user uploaded that still exist (Trash included, thumbnails not) may not exceed `ROOSTER_USER_STORAGE_MB` (default 1024 MB): an upload past it is `413 storage_quota_exceeded`, with `limitBytes` and `usedBytes`, and nothing is stored. Uploads are not idempotent (`Idempotency-Key` is not stored) and records `attachment_added` in the activity.',
  request: {
    params: z.object({ id: idParam('id', 'Task ID') }),
    body: multipartFile('The file. Its name is kept (cleaned) as the attachment’s file name.'),
  },
  responses: {
    201: json(AttachmentSchema, 'The attachment'),
    ...uploadProblems(
      '`ROOSTER_UPLOAD_MAX_MB`',
      ...AUTHED,
      404,
      'conflict_deleted',
      'too_many_attachments',
      'mime_mismatch',
      'storage_quota_exceeded',
    ),
  },
});

const downloadAttachment = createRoute({
  method: 'get',
  path: '/api/v1/attachments/{id}',
  tags: ['attachments'],
  operationId: 'downloadAttachment',
  summary: 'Download an attachment',
  description:
    "Needs read access to the task, else `404`. Local storage streams the file with its sniffed type, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`; S3 storage answers `302` to a presigned URL. `?inline=1` shows a raster image inline instead of downloading it; everything else (SVG included) is always an attachment.",
  request: {
    params: attachmentParams,
    query: z.object({
      inline: z
        .string()
        .optional()
        .openapi({ description: '`1`: inline for raster images.', example: '1' }),
    }),
  },
  responses: {
    200: binary('The file', ['*/*'], DOWNLOAD_HEADERS),
    302: REDIRECT,
    304: NOT_MODIFIED,
    ...problems(401, 404),
  },
});

const downloadThumb = createRoute({
  method: 'get',
  path: '/api/v1/attachments/{id}/thumb',
  tags: ['attachments'],
  operationId: 'downloadAttachmentThumb',
  summary: 'The WebP thumbnail of an image attachment',
  description:
    'Fits inside 320 × 320 px. Only attachments whose `image.thumb` is true have one; others are `404`.',
  request: { params: attachmentParams },
  responses: {
    200: binary('The thumbnail', ['image/webp'], DOWNLOAD_HEADERS),
    302: REDIRECT,
    304: NOT_MODIFIED,
    ...problems(401, 404),
  },
});

const deleteAttachment = createRoute({
  method: 'delete',
  path: '/api/v1/attachments/{id}',
  tags: ['attachments'],
  operationId: 'deleteAttachment',
  summary: 'Delete an attachment (no undo)',
  description:
    'Only the person who attached it or the task’s assignee (`403 forbidden` for other members). The file is removed from storage shortly after.',
  request: { params: attachmentParams },
  responses: {
    204: { description: 'Deleted' },
    ...problems(...AUTHED, 404, 'forbidden', 'conflict_deleted'),
  },
});

/**
 * Private downloads may be kept by the browser but never reused without asking: a shared
 * browser after sign-out would otherwise show the previous user's files from its cache. Every
 * use revalidates (`304` only after the access check), so a signed-out request gets `401`.
 */
export const PRIVATE_REVALIDATE = 'private, no-cache';

/** Sends a download: the stream with the §3.5 headers, a `304`, or the presigned redirect. */
export function sendDownload(c: Context<AppEnv>, download: AttachmentDownload): Response {
  if (download.kind === 'redirect') {
    return c.body(null, 302, { Location: download.url, 'Cache-Control': 'no-store' });
  }
  if (download.kind === 'not-modified') {
    return c.body(null, 304, { ETag: download.etag, 'Cache-Control': PRIVATE_REVALIDATE });
  }
  const headers: Record<string, string> = {
    'Content-Type': download.contentType,
    'Content-Disposition': download.disposition,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': DOWNLOAD_CSP,
    'Cache-Control': PRIVATE_REVALIDATE,
    ETag: download.etag,
  };
  if (download.size !== null) headers['Content-Length'] = String(download.size);
  return c.body(Readable.toWeb(download.stream) as ReadableStream<Uint8Array>, 200, headers);
}

const truthy = (v: string | undefined) => v === '1' || v === 'true';

/** Attachments (06 §2.7, FR-ATT, ADR 0049 §3). */
export function registerAttachmentRoutes(
  app: OpenAPIHono<AppEnv>,
  { attachments }: Services,
): void {
  app.openapi(uploadAttachment, async (c) => {
    const actor = actorOf(c);
    const { id } = c.req.valid('param');
    const attachment = await closingOnTooLarge(c, () =>
      attachments.upload(actor, id, uploadRequestOf(c), metaOf(c)),
    );
    return c.json(attachment, 201);
  });
  app.openapi(downloadAttachment, async (c) => {
    const actor = actorOf(c);
    const download = await attachments.download(actor, c.req.valid('param').id, {
      inline: truthy(c.req.valid('query').inline),
      ifNoneMatch: c.req.header('if-none-match'),
    });
    return sendDownload(c, download);
  });
  app.openapi(downloadThumb, async (c) => {
    const actor = actorOf(c);
    const download = await attachments.download(actor, c.req.valid('param').id, {
      thumb: true,
      ifNoneMatch: c.req.header('if-none-match'),
    });
    return sendDownload(c, download);
  });
  app.openapi(deleteAttachment, (c) => {
    attachments.remove(actorOf(c), c.req.valid('param').id, metaOf(c));
    return c.body(null, 204);
  });
}
