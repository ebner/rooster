import { z } from 'zod';
import { timestampSchema } from './common.ts';
import { taskSchema } from './list.ts';

/**
 * Phase 5 search contract (01 FR-VIEW-3, 04 §4.7, 06 §2.8). The query string uses the grammar
 * parsed by `parseSearchQuery` (`@rooster/core/search`): free terms become prefix matches, and
 * `#tag`, `@person`, `due:<when>` and `is:open|done` are filters. The same parser drives the
 * server (FTS5) and the web palette's offline filtering of cached tasks.
 */

export const SEARCH_QUERY_MAX = 200;
export const SEARCH_LIMIT_DEFAULT = 50;
export const SEARCH_LIMIT_MAX = 50;

export { SNIPPET_MARK_END, SNIPPET_MARK_START } from '../limits.ts';

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(SEARCH_QUERY_MAX),
  /** Org ID, slug or `personal`. Absent = every org the actor is a member of. */
  orgId: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(SEARCH_LIMIT_MAX).optional(),
});

export const searchHitSchema = z.object({
  task: taskSchema,
  orgId: z.string(),
  /**
   * A short excerpt of the best-matching field (title, else description, else comments), with
   * matches wrapped in `SNIPPET_MARK_START` … `SNIPPET_MARK_END`.
   */
  snippet: z.string(),
});

/** 06 §2.8: a bare array, ranked best first (open tasks before completed ones). */
export const searchResultSchema = z.array(searchHitSchema);

/** `POST /admin/search/reindex` (ADR 0012): rebuilds `task_fts` from the task table. */
export const reindexResultSchema = z.object({
  indexed: z.int().nonnegative(),
  durationMs: z.int().nonnegative(),
  finishedAt: timestampSchema,
});

export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type SearchHit = z.infer<typeof searchHitSchema>;
export type SearchResult = z.infer<typeof searchResultSchema>;
export type ReindexResult = z.infer<typeof reindexResultSchema>;
