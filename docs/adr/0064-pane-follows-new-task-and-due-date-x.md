# ADR 0064: The pane switches to a task created while it is open; an X clears the due date

- Status: accepted
- Date: 2026-10-21
- Amends: 02 §3.2 (the pane shows the selected row, D-29), 02 §9 (detail pane properties)
- Code: `apps/web/src/features/list/my-list-view.tsx`, `controller.ts`, `apps/web/src/state/list-store.ts`, `apps/web/src/features/pane/detail-pane.tsx`

## Context
Two requests from daily use:

1. **A new task never reached the open pane.** The pane follows the cursor (D-29), but a new task starts as a draft row, which has no details yet. When its title is committed, the task keeps the draft's id, so the cursor never changes and the pane went on showing the task it showed before. To add a description, the user had to select another row and click the new task again.
2. **Clearing a due date took the date picker:** open it, then "No date" (or Alt+0). The list's date cell clears with Backspace or Delete, but the pane had no direct way.

## Decisions
1. **The pane follows a task created from a draft.** When a draft's title is committed (Enter, Esc, Tab, blur), the list store records the new task (`created`), and a list view whose pane is open switches the pane to it. A multi-selection keeps the pane closed. Subtasks typed in the pane's own subtask list don't move the pane: they use the pane's own list store. A task created for someone else, which leaves this list, doesn't take the pane either.
2. **Pane shortcuts from an empty new row reach the pane's task.** After Enter, the caret waits in the next, empty draft while the pane shows the task just created. O, Tab+Enter and Tab+R there act on the pane's task, so Tab+R writes the new task's description at once; the empty draft goes away when focus leaves it.
3. **An X next to the due date** in the pane (desktop and the phone sheet) clears it the same way as the picker's "No date": the due date, time and start date go, and a repeat ends (ADR 0049 §1.8). It is undoable like every list edit. The X shows only when there is a due date. It's an ordinary button in the tab order; the keyboard already clears a date with Backspace or Delete on the date cell and Alt+0 in the picker.

## Considered
- **Showing the draft in the pane while its title is being typed.** The task doesn't exist until its title is committed (an empty draft creates nothing), so the pane would need a pre-creation state of its own. Switching on commit is as early as the task exists.
- **Creating the task before the title is committed.** Rejected: it would undo the rule that an empty draft disappears without a trace (02 §3.4).
