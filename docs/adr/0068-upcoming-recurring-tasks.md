# ADR 0068: Recurring tasks wait for their day (the Recurring section)

- Status: accepted
- Date: 2026-11-11
- Amends: 01 FR-REC-3 (adds FR-REC-5), 02 §4 (groups), 07 §4 (`ls --upcoming`); refines ADR 0049 §4 (placement of the next instance)
- Code: `packages/core/src/upcoming.ts`, `packages/core/src/views.ts` (`viewCounts.my`); web `apps/web/src/features/list/{model/rows.ts,upcoming.ts,upcoming-header.tsx,controller.ts}`; `apps/cli/src/commands/list.ts`, `apps/cli/src/tui/*`; `packages/mcp/src/{format,server,skill}.ts`

## Context
Completing a recurring task creates the next instance in the same group, directly after the completed one (ADR 0049 §4). A weekly task due next Monday therefore sat in the user's *Today* group all week, and a monthly one for a month. The smart views were never the problem: Today and Next 7 days go by date. The clutter was in My tasks, whose groups mean what the user makes them mean.

## Decisions
1. **The Recurring section.** In My tasks, an open, top-level recurring task whose day hasn't come yet is held out of its group and listed in a collapsed system section **↻ Recurring** (sv *Återkommande*) at the end of the list, after "+ Add group". Its day is its start date if it has one, otherwise its due date, as a date in the viewer's timezone (`isUpcoming(task, today)`, `upcomingDay`). The code calls the state *upcoming* (the task's day is still to come); the section's name is *Recurring*, because the default group *Upcoming* (sv *Kommande*, created for every user) is the user's own and two headers with one name would be ambiguous, also to screen readers.
2. **On its day it is back in its group,** at its own position. The placement never changes and nothing is written to the server: the section is a presentation of the list, so it works offline and needs no migration or API change. The viewer's today rolls over at midnight and when the tab becomes visible again; the TUI re-derives it every minute.
3. **The smart views don't change.** Today, Next 7 days, Overdue and No date stay date-based, as do Everyone's tasks, search and the palette.
4. **Order:** by day, then due date, then due time (untimed last), then title, then id (`compareUpcoming`). The section can't be reordered.
5. **Rows in Recurring** show their date and the group they go back to (not when that is the Inbox). They can be completed (early completion makes the next instance as usual; the completed row stays through its completion hold), edited and opened, but:
   - they can't be dragged or moved: Ctrl/⌘+↑↓, Alt+Shift moves, M, Tab+M, the bulk Move and a phone swipe set to Move do nothing on them and explain that changing the date brings a task back; a mixed bulk selection moves the others;
   - nothing is dropped into the section; in a group drag its header counts as "after the last group";
   - no new rows are created there: N, Shift+N, S and Tab+S explain it; Enter and Shift+Enter commit and return to Navigate; Tab+N adds a group at the end; colon-to-group is off. The pane's group picker still sets the group a task goes back to.
6. **The header** is a navigable row (aria-expanded): a click or tap, the chevron and ←/→ fold and open it; Enter, F2 and X do nothing on it; Ctrl+A there selects its tasks first; "Collapse all / Expand all groups" leaves it alone. It is shown only when it holds tasks and is folded by default. The open state is kept per user and org on the device (`userStorageKey`, swept on sign-out); the TUI keeps it for the session.
7. **What isn't held back:** completed instances (with "Show completed" they stay in their group), non-recurring tasks with a future date (the group is the user's plan), tasks without a date, and recurring subtasks (they stay under their parent; the parent row is the unit). An Inbox whose only open tasks are held back is hidden.
8. **Counts.** Group counts and the My tasks badge (`viewCounts.my`) leave held-back tasks out; Today and Next 7 days are unchanged.
9. **Feedback.** Completing (or skipping) a recurring task says where the next one went: "Next: Mon · in Recurring" in the completion toast. When the user's own edit sends a task there (a date change, a title or new task with a future repeat), a toast says "“X” is in Recurring until Mon". The cursor moves to the neighbouring row when the section is folded (it follows the task into an open one), and a row whose date picker is open stays put until the picker closes.
10. **One rule everywhere My tasks is shown.**
    - **`rooster ls`** leaves held-back tasks out and prints a muted "3 tasks in Recurring not shown (add --upcoming)"; `--upcoming` adds the section after the groups. `--group` and `--tag` narrow it too. `--json` stays complete and backwards compatible: every task, each with `upcoming: true|false`. `--upcoming` with a view is a usage error.
    - **The TUI** ends My tasks with the folded section; ←/→ and Enter toggle it; moves (J, K, ], [, m) explain why not; `n` there opens a draft at the top of the list. When an edit sends a task there, the status line says so.
    - **MCP** rows of held-back tasks carry `upcoming: true`; `list_tasks` view `my` lists them last, and the My tasks resource has a "Recurring" part. The tool description and the skill tell agents never to move such a task to bring it back.
11. **Print** includes the section only when it is open.

## Considered
- **A fixed "Recurring" group** holding every recurring task, due or not. Simpler, but the user loses control over where a due recurring task sits in their list.
- **A per-task lead time** ("show 3 days before"). More control, one more setting; Next 7 days already shows what is coming within the week.
- **Moving the next instance to another group on the server.** It would rewrite placements and fight the user's own order.
- **Naming the section "Upcoming".** It collides with the default group of that name.
