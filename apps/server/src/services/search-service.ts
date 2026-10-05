import { todayIn } from '@rooster/core/dates';
import {
  type ReindexResult,
  SEARCH_LIMIT_DEFAULT,
  type SearchQuery,
  type SearchResult,
  SNIPPET_MARK_END,
  SNIPPET_MARK_START,
  type Task,
} from '@rooster/core/schemas';
import {
  type LocalSearchContext,
  matchesFilters,
  type ParsedSearchQuery,
  parseSearchQuery,
  toFtsMatch,
} from '@rooster/core/search';
import { and, asc, desc, eq, inArray, isNotNull, isNull, type SQL, sql } from 'drizzle-orm';
import { member, tag as tagTable, task, user } from '../db/schema/index.ts';
import { AppError } from '../lib/errors.ts';
import { type Actor, immediate, type ServiceDeps, type Tx } from './context.ts';
import { chunked, liveTasksById, taskDtos } from './list-access.ts';
import { listMemberships, requireMembership } from './org-access.ts';
import { indexIsStale, rebuildIndex } from './search-index.ts';
import { toTagDto } from './tag-service.ts';

/** bm25 column weights: task_id, org_id (unindexed), title, description, comments. */
const BM25 = sql.raw('bm25(task_fts, 0.0, 0.0, 10.0, 1.0, 1.0)');
/** Tokens of context around a snippet's match. */
const SNIPPET_TOKENS = 12;
/** Candidates are filtered in batches of this many (filters need the full TaskDTO). */
const FILTER_BATCH = 200;

/**
 * A parsed query bound to one actor and a set of orgs: the FTS5 expression for the terms
 * (null for a filter-only query) and the filter predicate over task DTOs. Filters use the
 * core `matchesFilters`, so `#tag`, `@person`, `due:` and `is:` mean
 * exactly what they mean offline in the palette.
 */
export interface SearchMatcher {
  parsed: ParsedSearchQuery;
  fts: string | null;
  hasFilters: boolean;
  accepts(dto: Task): boolean;
}

function hasFilters(parsed: ParsedSearchQuery): boolean {
  return (
    parsed.tags.length > 0 ||
    parsed.people.length > 0 ||
    parsed.due !== null ||
    parsed.status !== 'any'
  );
}

/** A malformed FTS5 expression (never expected after `toFtsMatch`) matches nothing. */
function isFtsSyntaxError(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    err.code === 'SQLITE_ERROR' &&
    /fts5|unterminated string|syntax error|no such column/i.test(err.message)
  );
}

/** `SearchService` (04 §4.7): FTS5 search over the actor's orgs, plus index rebuilds. */
export class SearchService {
  constructor(private readonly deps: ServiceDeps) {}

  /**
   * `GET /search` (06 §2.8). Terms are prefix matches over title, description and comments;
   * filters narrow the result. Ranked open before completed, then by bm25 (title weighted
   * 10:1). A filter-only query ranks open first, then by due date (none last), then the most
   * recently updated. `orgId` limits the search to one org (404 for non-members).
   */
  search(actor: Actor, input: SearchQuery): SearchResult {
    return immediate(this.deps.db, (tx) => {
      const orgIds =
        input.orgId === undefined
          ? listMemberships(tx, actor.userId).map((m) => m.org.id)
          : [requireMembership(tx, actor.userId, input.orgId).org.id];
      if (orgIds.length === 0) return [];
      const matcher = this.matcher(tx, actor, orgIds, input.q);
      if (matcher === null) return [];
      const limit = input.limit ?? SEARCH_LIMIT_DEFAULT;
      const ids = this.candidates(tx, orgIds, matcher, matcher.hasFilters ? null : limit);
      const hits: Task[] = [];
      for (const batch of chunked(ids, FILTER_BATCH)) {
        const order = new Map(batch.map((id, i) => [id, i]));
        const rows = liveTasksById(tx, batch).sort(
          (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
        );
        for (const dto of taskDtos(tx, actor.userId, rows)) {
          if (matcher.accepts(dto)) hits.push(dto);
          if (hits.length === limit) break;
        }
        if (hits.length === limit) break;
      }
      const snippets = this.snippets(
        tx,
        matcher.fts,
        hits.map((h) => h.id),
      );
      return hits.map((dto) => ({
        task: dto,
        orgId: dto.orgId,
        snippet: snippets.get(dto.id) ?? dto.title,
      }));
    });
  }

  /**
   * The matcher for `q` in `orgIds`, or null when the query cannot match anything: a palette
   * actions query (`>`), or neither terms nor filters.
   */
  matcher(tx: Tx, actor: Actor, orgIds: readonly string[], q: string): SearchMatcher | null {
    const parsed = parseSearchQuery(q);
    if (parsed.actionsOnly) return null;
    const fts = toFtsMatch(parsed.terms);
    const filters = hasFilters(parsed);
    if (fts === null && !filters) return null;
    if (!filters) return { parsed, fts, hasFilters: false, accepts: () => true };
    const ctx = this.localContext(tx, actor, orgIds, parsed);
    return { parsed, fts, hasFilters: true, accepts: (dto) => matchesFilters(dto, parsed, ctx) };
  }

  /** IDs of live tasks in `orgIds` matching the terms, or null for a filter-only query. */
  matchingIds(tx: Tx, orgIds: readonly string[], fts: string | null): Set<string> | null {
    if (fts === null) return null;
    return new Set(this.ftsCandidates(tx, orgIds, fts, null, null));
  }

  private localContext(
    tx: Tx,
    actor: Actor,
    orgIds: readonly string[],
    parsed: ParsedSearchQuery,
  ): LocalSearchContext {
    const viewerTz =
      tx.select({ timezone: user.timezone }).from(user).where(eq(user.id, actor.userId)).get()
        ?.timezone ?? 'UTC';
    const nowMs = this.deps.clock();
    const tagsById: LocalSearchContext['tagsById'] =
      parsed.tags.length === 0
        ? {}
        : Object.fromEntries(
            tx
              .select()
              .from(tagTable)
              .where(inArray(tagTable.orgId, [...orgIds]))
              .all()
              .map((t) => [t.id, toTagDto(t)]),
          );
    const membersById: Record<string, { name: string; email: string }> = {};
    if (parsed.people.length > 0) {
      for (const m of tx
        .selectDistinct({ id: user.id, name: user.name, email: user.email })
        .from(member)
        .innerJoin(user, eq(user.id, member.userId))
        .where(inArray(member.organizationId, [...orgIds]))
        .all()) {
        membersById[m.id] = { name: m.name, email: m.email };
      }
    }
    return {
      today: todayIn(viewerTz, nowMs),
      nowMs,
      viewerTz,
      viewerId: actor.userId,
      tagsById,
      membersById,
    };
  }

  /** Ranked candidate IDs (live tasks of `orgIds`), at most `limit` when given. */
  private candidates(
    tx: Tx,
    orgIds: readonly string[],
    matcher: SearchMatcher,
    limit: number | null,
  ): string[] {
    const status = matcher.parsed.status;
    if (matcher.fts !== null) return this.ftsCandidates(tx, orgIds, matcher.fts, status, limit);
    const query = tx
      .select({ id: task.id })
      .from(task)
      .where(
        and(
          inArray(task.orgId, [...orgIds]),
          isNull(task.deletedAt),
          status === 'open' ? isNull(task.completedAt) : undefined,
          status === 'done' ? isNotNull(task.completedAt) : undefined,
        ),
      )
      .orderBy(
        sql`${task.completedAt} IS NOT NULL`,
        sql`${task.dueDate} IS NULL`,
        asc(task.dueDate),
        sql`${task.dueTime} IS NULL`,
        asc(task.dueTime),
        desc(task.updatedAt),
        asc(task.id),
      );
    return (limit === null ? query.all() : query.limit(limit).all()).map((r) => r.id);
  }

  private ftsCandidates(
    tx: Tx,
    orgIds: readonly string[],
    fts: string,
    status: ParsedSearchQuery['status'] | null,
    limit: number | null,
  ): string[] {
    if (orgIds.length === 0) return [];
    const orgList = sql.join(
      orgIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const statusSql: SQL =
      status === 'open'
        ? sql` AND t.completed_at IS NULL`
        : status === 'done'
          ? sql` AND t.completed_at IS NOT NULL`
          : sql``;
    const limitSql: SQL = limit === null ? sql`` : sql` LIMIT ${limit}`;
    try {
      return tx
        .all<{ id: string }>(
          sql`SELECT t.id AS id FROM task_fts JOIN task t ON t.id = task_fts.task_id
            WHERE task_fts MATCH ${fts} AND t.org_id IN (${orgList}) AND t.deleted_at IS NULL${statusSql}
            ORDER BY t.completed_at IS NOT NULL, ${BM25}, t.id${limitSql}`,
        )
        .map((r) => r.id);
    } catch (err) {
      if (isFtsSyntaxError(err)) {
        this.deps.logger.warn({ err, fts }, 'search: rejected FTS expression');
        return [];
      }
      throw err;
    }
  }

  /**
   * Highlighted excerpts: the title when it matched, else the description, else comments.
   * Filter-only hits (and anything without a marked match) fall back to the plain title.
   */
  private snippets(tx: Tx, fts: string | null, ids: readonly string[]): Map<string, string> {
    const out = new Map<string, string>();
    if (fts === null || ids.length === 0) return out;
    const snip = (col: number) =>
      sql.raw(
        `snippet(task_fts, ${col}, '${SNIPPET_MARK_START}', '${SNIPPET_MARK_END}', '…', ${SNIPPET_TOKENS})`,
      );
    for (const chunk of chunked(ids)) {
      const list = sql.join(
        chunk.map((id) => sql`${id}`),
        sql`, `,
      );
      const rows = tx.all<{ id: string; title: string; description: string; comments: string }>(
        sql`SELECT task_id AS id, ${snip(2)} AS title, ${snip(3)} AS description,
          ${snip(4)} AS comments FROM task_fts WHERE task_fts MATCH ${fts} AND task_id IN (${list})`,
      );
      for (const r of rows) {
        const best = [r.title, r.description, r.comments].find((s) =>
          s.includes(SNIPPET_MARK_START),
        );
        if (best !== undefined) out.set(r.id, best);
      }
    }
    return out;
  }

  // --- index rebuilds -----------------------------------------------------------------------

  /** `POST /admin/search/reindex` (ADR 0012): instance admins only. */
  reindex(actor: Actor): ReindexResult {
    if (!actor.isAdmin) throw new AppError('forbidden', 403, 'Only instance admins can do that.');
    return this.rebuild();
  }

  /** Rebuilds `task_fts` from the task table in one transaction. */
  rebuild(): ReindexResult {
    const started = performance.now();
    const indexed = immediate(this.deps.db, (tx) => rebuildIndex(tx));
    return {
      indexed,
      durationMs: Math.round(performance.now() - started),
      finishedAt: this.deps.clock(),
    };
  }

  /**
   * Boot check (05 §3): rebuilds when the index row count differs from the number of
   * non-deleted tasks. Returns the rebuild, or null when the index was consistent.
   */
  rebuildIfStale(): (ReindexResult & { before: number }) | null {
    const check = immediate(this.deps.db, (tx) => indexIsStale(tx));
    if (!check.stale) return null;
    return { ...this.rebuild(), before: check.indexed };
  }
}
