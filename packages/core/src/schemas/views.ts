import { z } from 'zod';
import { idSchema, timestampSchema } from './common.ts';
import { orderingIntentSchema, positionSchema, taskSchema } from './list.ts';
import { nameSchema } from './text.ts';

/**
 * Phase 13 (ADR 0073 B): views, saved queries in one org. Stored as JSON in
 * `saved_view.query` (05 §3) and validated with `savedViewQuerySchema`; the matcher and the
 * row selector are in `@rooster/core/saved-views`.
 */

export const VIEW_TAGS_MAX = 20;
export const VIEW_NAME_MAX = 60;
export const VIEW_DUE_FILTERS = ['any', 'today', 'week', 'overdue', 'none'] as const;
export const VIEW_STATUS_FILTERS = ['open', 'done', 'any'] as const;

export const savedViewQuerySchema = z.object({
  /** Tag IDs of the view's org (renames follow; deletes and merges are remapped). */
  tags: z.array(idSchema).max(VIEW_TAGS_MAX).default([]),
  /** With several tags: a task carrying any of them, or all of them. */
  tagMode: z.enum(['any', 'all']).default('any'),
  /** `me` is whoever looks at the view; a user ID names one member. */
  assignee: z.union([z.enum(['anyone', 'me', 'unassigned']), idSchema]).default('anyone'),
  /** As the smart views and the search `due:` filter: `today` includes overdue. */
  due: z.enum(VIEW_DUE_FILTERS).default('any'),
  /** `open` (the default) still shows completed tasks with the header's "Show completed". */
  status: z.enum(VIEW_STATUS_FILTERS).default('open'),
});

export const savedViewNameSchema = nameSchema(VIEW_NAME_MAX);

export const savedViewSchema = z.object({
  id: idSchema,
  orgId: idSchema,
  createdBy: idSchema,
  /** Shared with every member; always false in a personal org. */
  shared: z.boolean(),
  name: z.string(),
  query: savedViewQuerySchema,
  archivedAt: timestampSchema.nullable(),
  /** The requesting member's own sidebar order (fractional key). */
  position: positionSchema,
  /** Open tasks matching the query, ignoring its status filter (the sidebar count). */
  openCount: z.int().nonnegative(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const savedViewCreateSchema = z.object({
  id: idSchema.optional(),
  name: savedViewNameSchema,
  query: savedViewQuerySchema,
  /** Ignored (false) in a personal org. Default false. */
  shared: z.boolean().optional(),
});

export const savedViewPatchSchema = z
  .object({
    name: savedViewNameSchema.optional(),
    query: savedViewQuerySchema.optional(),
    shared: z.boolean().optional(),
  })
  .refine((p) => Object.keys(p).length > 0, { error: 'Nothing to change' });

/** The actor's own sidebar order (06 §1 ordering intents). */
export const savedViewMoveSchema = orderingIntentSchema;

export const savedViewListQuerySchema = z.object({
  /** `true`: the archived views (Org settings → Views) instead of the live ones. */
  archived: z.enum(['true', 'false']).optional(),
});

export const savedViewTasksQuerySchema = z.object({
  /** `true` also lists completed matches (the header's "Show completed"). Default `false`. */
  completed: z.enum(['true', 'false']).optional(),
});

export const savedViewTasksSchema = z.object({
  /** Every matching task, subtasks included; the client groups them (`selectSavedView`). */
  items: z.array(taskSchema),
  /** Matches by completion, ignoring the status filter: "7 open · 12 done". */
  counts: z.object({ open: z.int().nonnegative(), done: z.int().nonnegative() }),
});

export type SavedViewQuery = z.infer<typeof savedViewQuerySchema>;
export type SavedViewQueryInput = z.input<typeof savedViewQuerySchema>;
export type SavedView = z.infer<typeof savedViewSchema>;
export type SavedViewCreate = z.infer<typeof savedViewCreateSchema>;
export type SavedViewPatch = z.infer<typeof savedViewPatchSchema>;
export type SavedViewMove = z.infer<typeof savedViewMoveSchema>;
export type SavedViewListQuery = z.infer<typeof savedViewListQuerySchema>;
export type SavedViewTasksQuery = z.infer<typeof savedViewTasksQuerySchema>;
export type SavedViewTasks = z.infer<typeof savedViewTasksSchema>;
