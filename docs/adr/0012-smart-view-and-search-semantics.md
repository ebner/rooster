# ADR 0012: Smart view and search semantics (Phase 5, WP 5.1–5.3, core)

- Status: accepted
- Date: 2026-10-05
- Refines: 01 FR-VIEW-1/3/4; 02 §3.4, §10, §12; 04 §4.7, §5.1
- Code: `packages/core/src/views.ts`, `packages/core/src/search.ts`

Both modules are pure and shared: the web derives smart views, sidebar badges and offline palette results from the cached `my-list`, and the server uses the same functions for `GET /orgs/:id/tasks?view=` and for the filters of `GET /search`. Change them in one place only.

## Smart views
1. **Membership.** A smart view covers live tasks (no `deletedAt`) assigned to the viewer, subtasks included. Completed tasks appear only with "Show completed", and are classified by their due date as if they were open, so they stay in their section.
2. **Sections.**
   - Today is `[overdue?, today]`. Overdue is omitted when empty, but `today` is always present.
   - Next 7 days is always seven `day` sections, from today to today + 6, even when empty: 02 §3.4 needs the empty "Wed" header to add a task there.
   - Overdue is one `overdue` section, or `[]`.
   - No date is always one `flat` section.
3. **`section.date`** is the due date that an inline add inherits: today, the day, or null (No date). Overdue has no inline add.
4. **Order inside a section** is My tasks order.
   - Group order (Inbox first), then position, then ID.
   - A subtask without its own placement follows its parent, depth first, in subtask order.
   - Tasks the walk cannot reach go last, by `createdAt`.
   - Time of day does not reorder Today or a Week day.
   - The `overdue` section sorts by due date ascending first, with timed before untimed on the same day and then by `dueTime`.
5. **Overdue** means `dueDate < today`, or a timed due whose instant has passed (ADR 0001). Next 7 days buckets purely by date, so a timed task due today that has already passed sits under today in Week but under Overdue in Today.
6. **Counts** (sidebar badges) ignore "Show completed".
   - `my` counts open tasks placed in a known group, which are the rows of My tasks.
   - `today` counts overdue tasks plus those due today. `week`, `overdue` and `nodate` count the corresponding views.
   - Each count equals the number of rows that `selectView` returns (tested).

## Search grammar
7. **Terms.** Free words are terms, each a prefix match. Case and diacritics are folded, the same way as the FTS5 `unicode61 remove_diacritics 2` tokenizer. `"…"` keeps a phrase together, and its last word is a prefix. A term without any letter or digit is dropped, because in FTS5 it matches nothing and would empty the AND.
8. **Filters.**
   - `#tag`: matches a tag whose name starts with the value. Several tags AND-combine.
   - `@person`: `me`, or a prefix of the member's name, a word of the name, or the email. Several people OR-combine.
   - `due:today|week|overdue|none`: mirrors the smart views (`today` includes overdue).
   - `is:open|done`.
   - Swedish aliases: `due:idag|vecka|försenade|inget` and `is:öppen|klar`.
   - When `due:` or `is:` is repeated, the last one wins.
   - Unknown keys or values become plain terms. A bare `#`, `@`, `due:` or `is:` (the user is still typing) is ignored.
9. **`>` prefix:** the query is for actions only. `text` is the query without its filters and prefix, and is what the palette matches actions against.
10. **`toFtsMatch`** builds `"term"*` clauses joined by ` AND `, doubling any `"` inside a term. It returns null for a query with filters only. 2,000 random queries (FTS operators, quotes, emoji, NUL) ran against a real FTS5 table without a parse error.
11. **Offline matching** (`matchesTask`) covers titles only, because descriptions are not in the list cache. It uses the same word splitting and prefix rule as FTS5. `matchesFilters` holds the filter half, which the server applies after its FTS match, so online and offline filters agree.
12. **`fuzzyScore`** (palette actions) is an fzf-style subsequence score that ignores case and diacritics.
    - Bonuses for word starts, camelCase humps and consecutive runs.
    - Gap penalties, with no penalty for skipped leading characters.
    - A small length penalty breaks ties towards shorter labels.
    - It uses dynamic programming to find the best alignment. An empty query scores 0 and a non-match scores null.
