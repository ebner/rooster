# ADR 0015: Smart view screens (Phase 5, WP 5.1 web)

- Status: accepted
- Date: 2026-10-06
- Refines: 01 FR-VIEW-1; 02 §2, §3.4, §5, §10, §13, §14; ADR 0008 ("Make subtask of…"), ADR 0011 (the phone view switcher)
- Code: `apps/web/src/features/views/`, `features/list/model/view-rows.ts`, `features/list/section-header.tsx`, `features/list/view-empty.tsx`, routes `o.$orgSlug._tasks.{today,week,overdue,nodate}.tsx`

## Decisions
1. **No drag and drop in smart views.** Their sections are derived, so keyboard moves do nothing there and Next 7 days re-dates with D. On phones, a long-press still enters selection mode.
2. **Flat rows.** Subtasks are their own rows with a breadcrumb and no chevron. Section headers exist only in Today and Next 7 days. They are not collapsible, and the cursor skips them. Overdue and No date are plain lists.
3. **Inline add (02 §3.4).**
   - A new task takes the section's date (ADR 0012) and goes to the top of the Inbox, or of the group chosen with `>Group` or the accessory bar.
   - Repeated Enter keeps typing order: each new task is placed after the previous one.
   - Enter always makes a new top-level task in the same section.
   - Q goes to the cursor's section, or else the first section that accepts adds.
   - S creates a subtask draft under its parent row, with the section's date.
   - A date phrase in the title overrides the inherited date.
4. **Overdue has no inline add.** There is no add row, N and Q do nothing, and the phone FAB is hidden.
5. **`>Group` matching.**
   - The exact name wins, then a case-insensitive match, then a case-insensitive prefix.
   - It applies only to new top-level tasks in a view.
   - An unknown name stays in the title, and a title that is only the token keeps it as text.
   - The date phrase is looked for with the token blanked, so a group called "Today" is not read as a date.
6. **Empty views** show the line-art rooster and the view's text, plus "Add task" where adding is allowed. Next 7 days keeps its seven day headers, so "Wed" stays addable.
7. **Labels and filters.**
   - Today's group chip sits before the tag chips.
   - Day headers read "Wednesday, Oct 7" (Swedish "Onsdag 7 okt").
   - The tag filter applies to every row in a view.
   - A row completed inside a view keeps its section during the hide delay.
8. **Sidebar badges** come from `viewCounts` per org through a TanStack `select` (`LiveViewCounts` context). They therefore never re-render the list; the AC-2.12 p95 stays around 37 ms with the counts on.
   - My tasks and Today show counts.
   - Overdue shows a danger count only when it is above 0.
   - Next 7 days and No date show none.
9. **The pane** opens over the last list view (`last-view.ts`). A direct load of `/o/:slug/t/:id` uses My tasks. Closing the pane returns to that view.
10. **Make subtask of…** (`controller.makeSubtaskOf`) sends one `task.patch {parentId}` per selected task, as a single undo step. Cycles and the depth limit (5) are skipped with a toast. It is published to the palette from My tasks and every smart view (ADR 0014).
