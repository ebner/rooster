import { z } from 'zod';
import { ATTACHMENT_FILENAME_MAX } from '../limits.ts';
import { idSchema, timestampSchema } from './common.ts';

/**
 * Phase 10 attachments (FR-ATT, 05 §3 `attachment`, 06 §2.7, 04 §4.8, ADR 0049). Uploads are
 * online-only multipart requests; they never go through the outbox.
 */

export { ATTACHMENT_FILENAME_MAX, ATTACHMENTS_PER_TASK_MAX, AVATAR_MAX_BYTES } from '../limits.ts';

export const attachmentSchema = z.object({
  id: idSchema,
  taskId: idSchema,
  /** The uploaded file name, cleaned of path parts and control characters. */
  filename: z.string().min(1).max(ATTACHMENT_FILENAME_MAX),
  /** The sniffed type (never the client's claim); `application/octet-stream` when unknown. */
  mime: z.string(),
  /** Bytes. */
  size: z.int().nonnegative(),
  uploaderId: idSchema,
  /**
   * Raster images (PNG, JPEG, GIF, WebP, AVIF) only: the pixel size, and whether a 320 px WebP
   * thumbnail exists (`GET /attachments/:id/thumb`). Such images may be shown inline
   * (`GET /attachments/:id?inline=1`); everything else downloads as an attachment.
   */
  image: z
    .object({ width: z.int().positive(), height: z.int().positive(), thumb: z.boolean() })
    .nullable(),
  createdAt: timestampSchema,
});

export type Attachment = z.infer<typeof attachmentSchema>;
