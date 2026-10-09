# ADR 0030: Collaboration in the reducers and the pipeline (Phase 6)

- Status: accepted
- Date: 2026-10-09
- Amends: 04 §6.2 (caches the pipeline writes), 02 §3.4 (the `@name` token), 02 §11 (Everyone's sections)
- Code: `packages/core/src/{everyone,activity,comment-markdown}.ts`, `packages/core/src/dates/tokens.ts` (`findAssigneeToken`), `packages/core/src/reducers/*`, `apps/web/src/data/pipeline/{pipeline,pending}.ts`

## Decisions
1. **Assignment in my-list.**
   - A task assigned away stays in `ListState` with `placement: null`. The row model and `viewCounts` only render or count placed tasks, the same as the orphan ancestors the server already sends.
   - A task assigned to me goes to the top of my Inbox, and its direct children are reconciled, as in 05 §4.1.
   - Every patch with `assigneeId`, and every bulk `assign`, refetches my-list and the Everyone caches. Rows for a newly assigned task and its children can only come from the server.
   - A task taken from Everyone's tasks therefore appears in My tasks only after the server confirms.
2. **Undo of an assign** is the inverse patch (one bulk `assign` per previous assignee), followed by `restorePlacements` moves for the task and its orphan children, so the exact group and position come back.
3. **Caches without a confirmed base.** The Everyone and activity caches take ops directly. Their query functions replay the queue (`pipeline.withPendingTasks` and `withPendingActivity`). A confirmation merges the server's DTO only when no later queued op touches the same entity, and a dropped op refetches. A replayed comment count can read one too high for a moment, and the next SSE refetch corrects it.
4. **Pending ops without a loaded list.** `enqueue` accepts an op whose org has no loaded my-list, for example a comment from a pane opened by link. The list's first fetch replays it.
5. **Undo of comments and follows.** `comment.create` and `comment.delete` undo as delete and restore. A comment edit and a follow toggle have no reducer inverse, because the caller knows the previous body or state. A restored comment that falls between two loaded pages goes into the newer page.
6. **Everyone's sections**:
   - Order: me, then members by `Intl.Collator(locale, {sensitivity: 'base'})`, then non-member assignees by ID, then Unassigned.
   - Member sections and Unassigned show even when empty, because each header has an inline add.
   - A task whose parent is not in the list counts as a row.
   - The "this week" filter is the Next 7 days window.
7. **Activity grouping.** The 5-minute window (FR-COL-5) runs from a group's first entry, and a comment breaks a run. A run of `description_edited` entries by one actor collapses into one line, however long it lasts.
8. **The `@name` token** follows the `>Group` position rule: only whitespace or a date phrase may follow it.
   - `@"Full name"` is also accepted, and no date is parsed inside the quotes.
   - Matching ignores case and accents. The order is: a whole name or email local part, a name prefix, a later word's prefix, then an email prefix.
   - An ambiguous match yields no user, and `@me` / `@mig` is the viewer. The server's `parse: true` uses the same function (ADR 0029).
9. **Comment Markdown** is a simplified CommonMark with no raw HTML:
   - Paragraphs, code blocks, and flat bulleted or numbered lists.
   - Inline: emphasis by the delimiter-run rules (nesting at most 8 levels), code spans, line breaks and mentions.
   - Links keep only `http`, `https` and `mailto`; anything else stays text. Bare URLs are linked, without trailing punctuation.
