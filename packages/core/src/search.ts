import type { DueContext } from './dates/index.ts';
import type { Tag, Task } from './schemas/index.ts';

/**
 * Search query grammar (01 FR-VIEW-3, 02 §12), shared by the server's FTS5 search and the web
 * palette (online results and offline filtering over cached tasks).
 *
 * - Free words are terms; each becomes a prefix match (`tand` matches `tandläkare`). Matching
 *   ignores case and diacritics, like the FTS5 `unicode61 remove_diacritics 2` tokenizer.
 * - `#tag` filters by tag name (prefix, case-insensitive), `@person` by assignee (P6 data; the
 *   name, email or `me`), `due:today|overdue|week|none` by due state, `is:open|done` by status.
 * - A leading `>` limits the palette to actions; the rest of the query fuzzy-matches them.
 * - Double quotes keep a phrase together as one term.
 *
 * CONTRACT (Phase 5 Step 0): the signatures below are fixed; the core agent implements them.
 */

export const SEARCH_DUE_FILTERS = ['today', 'overdue', 'week', 'none'] as const;
export type SearchDueFilter = (typeof SEARCH_DUE_FILTERS)[number];

export interface ParsedSearchQuery {
  /** `>` prefix: actions only (palette). */
  actionsOnly: boolean;
  /** Lower-cased, diacritics kept; phrase terms keep their spaces. */
  terms: string[];
  tags: string[];
  people: string[];
  due: SearchDueFilter | null;
  /** Default `any`: search ranks open tasks first but includes completed ones. */
  status: 'open' | 'done' | 'any';
  /** The query text without filters and prefix (what the palette fuzzy-matches actions on). */
  text: string;
}

export function parseSearchQuery(_q: string): ParsedSearchQuery {
  throw new Error('parseSearchQuery: not implemented (Phase 5, core agent)');
}

/**
 * The FTS5 MATCH expression for the terms (each a quoted prefix query, AND-combined), or null
 * when there are no terms (a filter-only query). Quotes inside terms are escaped.
 */
export function toFtsMatch(_terms: readonly string[]): string | null {
  throw new Error('toFtsMatch: not implemented (Phase 5, core agent)');
}

export interface LocalSearchContext extends DueContext {
  viewerId: string;
  tagsById: Readonly<Record<string, Tag>>;
  /** For `@person`; without it only `@me` matches offline. */
  membersById?: Readonly<Record<string, { name: string; email: string }>>;
}

/**
 * Offline search: whether a cached task matches the parsed query (terms as prefixes of any word
 * in the title; filters as above). Descriptions are not in the list cache, so offline search
 * covers titles only.
 */
export function matchesTask(
  _task: Task,
  _query: ParsedSearchQuery,
  _ctx: LocalSearchContext,
): boolean {
  throw new Error('matchesTask: not implemented (Phase 5, core agent)');
}

/**
 * Palette action matching: a subsequence fuzzy score of `query` against `label` (higher is
 * better; null = no match). Word starts and consecutive characters score higher.
 */
export function fuzzyScore(_query: string, _label: string): number | null {
  throw new Error('fuzzyScore: not implemented (Phase 5, core agent)');
}
