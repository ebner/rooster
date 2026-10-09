# ADR 0032: Assignment and Everyone's tasks in the web app (Phase 6)

- Status: accepted
- Date: 2026-10-09
- Amends: 02 §3.4 (`@name`), 02 §11 (Everyone's tasks), 02 §13 (phone assign)
- Code: `apps/web/src/features/people/*`, `features/list/controller.ts` (`assign`), `features/list/my-list-view.tsx`, `features/pane/tasks-screen.tsx`, `data/everyone.ts`, `packages/core/src/everyone.ts`

## Decisions
1. **Filters run on the client.** Everyone's tasks fetches the org's open rows once (cache `['everyone', orgId, 'open']`, every page). The due, member and tag filters run in `selectEveryone`, so changing a filter is instant and works offline.
2. **The tag filter is OR, as in My tasks.** Everyone's tasks reuses the list's tag filter control, so it keeps the list's semantics: tasks with any of the chosen tags. The API's `tag` parameter stays AND (06 §2.3), for the CLI.
3. **"This week"** is today to today + 6, the Next 7 days window.
4. **Every member has a section**, empty ones included, so a task can be added under anyone. Unassigned takes inline adds too (an unassigned task). The view shows open tasks only, so it has no Show completed toggle.
5. **No group moves in Everyone's tasks.** M, Tab+M, Move to and the "move" swipe are off there. The only drag is between member sections, and it reassigns. In phone selection mode, Assign replaces Move.
6. **`@name` works on new tasks only**, not on title edits. The autocomplete inserts `@First` when the first name is unique among members, otherwise `@"Full Name"`. A title made only of the token keeps it as text.
7. **Toasts and undo.** The toasts are:
   - Assigning someone else: "Assigned to X · moved to their Inbox".
   - Assigning yourself: "Assigned to you · moved to your Inbox".
   - Unassigning: "Task unassigned".
   - Creating for someone else: "Added to X's Inbox".

   All of them offer Undo and use the full name. The Swedish strings avoid name genitives ("i inkorgen för {name}").
8. **Selection after assigning away** moves on, as after a delete. A subtask rendered under its parent stays selected.
9. **Avatars** appear in Everyone's tasks and on subtasks assigned to someone else, including in the pane's subtask list. In a personal org (FR-COL-6) the list hides every assignee affordance: A and Tab+A, `@name`, avatars, bulk Assign, and the Everyone view (`/everyone` redirects to `/my`).
