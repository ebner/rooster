import { z } from 'zod';
import { idSchema, timestampSchema } from './common.ts';
import { groupSchema, taskSchema } from './list.ts';
import { tagSchema } from './tags.ts';

/**
 * Phase 5 export contract (01 FR-SET-5, 06 §2.8): `GET /orgs/:orgId/export?format=json|markdown`
 * returns the actor's data in one org as a download (`Content-Disposition: attachment`).
 * JSON is the lossless format below; Markdown is a readable rendering of the same data (ADR 0012).
 */

export const EXPORT_FORMATS = ['json', 'markdown'] as const;
export const exportFormatSchema = z.enum(EXPORT_FORMATS);

export const exportQuerySchema = z.object({
  /** Default `json`. */
  format: exportFormatSchema.optional(),
});

export const exportTaskSchema = taskSchema.extend({
  description: z.string(),
});

export const orgExportSchema = z.object({
  format: z.literal('rooster-export'),
  version: z.literal(1),
  exportedAt: timestampSchema,
  org: z.object({ id: idSchema, slug: z.string(), name: z.string() }),
  user: z.object({ id: idSchema, email: z.string(), name: z.string() }),
  /** The actor's groups, in order (Inbox first). */
  groups: z.array(groupSchema),
  /** Every org tag referenced by an exported task. */
  tags: z.array(tagSchema),
  /**
   * The actor's tasks (open and completed, not deleted) with their placements, plus every
   * descendant subtask (any assignee). Ordered by group order and position, subtasks after their
   * parent in subtask order.
   */
  tasks: z.array(exportTaskSchema),
  /** Reserved for comments (Phase 6); always empty in v1.0. */
  comments: z.array(z.never()),
});

export type ExportFormat = z.infer<typeof exportFormatSchema>;
export type ExportQuery = z.infer<typeof exportQuerySchema>;
export type ExportTask = z.infer<typeof exportTaskSchema>;
export type OrgExport = z.infer<typeof orgExportSchema>;
