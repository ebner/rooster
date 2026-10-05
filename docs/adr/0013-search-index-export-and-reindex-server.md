# ADR 0013: Search index, export and reindex on the server (Phase 5, WP 5.2, 5.4)

- Status: accepted
- Date: 2026-10-05
- Refines: 04 §4.7; 05 §1 (hand-written migrations), `task_fts`; 06 §2.3 (`q`), §2.8 (search, export), §2.10; 07 `rooster admin reindex`
- Code: `apps/server/src/services/search-index.ts`, `search-service.ts`, `export-service.ts`, `routes/search.ts`, `routes/export.ts`, migration `0004_task_fts.sql`

## Decisions
1. **Hand-written migrations.** `0004_task_fts.sql` is the first one.
   - It is created with `drizzle-kit generate --custom --name <name>`, which keeps the journal and snapshots consistent.
   - Statements are separated by `--> statement-breakpoint`.
   - `strictify-migrations.mjs` skips `CREATE VIRTUAL TABLE`.
   - `task_fts` is not in the drizzle schema, so later `db:generate` runs never touch it. Callers query it with raw SQL.
2. **One index row per task that is not soft-deleted**, whatever its org's state. Search hides other orgs through live membership.
   - Soft delete removes the row, restore re-adds it, and the purge and permanent delete prune it.
   - `indexTasks(tx, ids)` runs in the same transaction at every write that changes the title, description or `deleted_at`. Any new write path must call it too.
   - `comments` stays empty until Phase 6, which must fill it.
3. **Ranking.**
   - With terms: open before completed, then `bm25(task_fts, 0, 0, 10, 1, 1)` (a title match weighs 10, a description or comment match 1), then ID.
   - With filters only: open first, then due date (no date last), due time, `updatedAt` descending, and ID.
   - The limit is 50.
4. **Empty results.**
   - A query that starts with `>` (palette actions), or that has neither terms nor filters, returns `[]`.
   - An expression that FTS5 rejects also returns `[]` and logs a warning. Search never answers 500 to user input (fuzz-tested).
5. **Snippet:** FTS5 `snippet()` with 12 tokens of context and the U+E000/U+E001 markers. It prefers the title if the title matched, then the description, then comments, and falls back to the plain title.
6. **`q` on `GET /orgs/:id/tasks`** narrows the view and keeps the view's order, not relevance. The filters use core `matchesFilters`, as search does.
7. **`?view=` uses core `selectView`.**
   - The source is the actor's groups and live tasks, each with the actor's placement.
   - The section order is flattened, and then the existing filters and offset paging apply.
   - `view=today|week` now return Overdue first, then My tasks order (previously due-date order). The sets are unchanged.
8. **Reindex.** `rooster admin reindex` arrives with the CLI in Phase 8; it will call `POST /api/v1/admin/search/reindex` (instance admins; 403 `forbidden` otherwise). The endpoint rebuilds the index in one transaction. At boot the server rebuilds the index when its row count differs from the number of live tasks, and logs `search index rebuilt`.
9. **Export, both formats.** `GET /orgs/:id/export?format=json|markdown` is a plain authenticated GET.
   - Headers: `Content-Disposition: attachment; filename="rooster-<slug>-<yyyy-mm-dd>.json|md"` (the date is today in the actor's timezone) and `Cache-Control: no-store`.
   - Tasks are the actor's placed tasks in group order and position. Each is followed depth first by its live subtasks (any assignee), deduplicated.
   - Tags are those referenced, ordered by creation.
10. **Export, Markdown details.**
    - A `# Org` title, then every group as a `##` heading, including empty groups.
    - Tasks are `- [ ]` or `- [x]` lines, followed by ` — due YYYY-MM-DD[ HH:MM]` (or ` — start …, due …`) and the `#tag` names in chip order.
    - Subtasks and descriptions are indented two spaces deeper than their task.
    - A placed task is listed in its group, even when it is a subtask of someone else's task.
11. **OpenAPI:** `comments` in `OrgExport` is declared as `{type: array, maxItems: 0}`, because `z.never()` has no OpenAPI form.
