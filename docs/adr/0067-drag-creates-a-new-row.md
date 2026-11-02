# ADR 0067: Dragging a new row creates its task

- Status: accepted
- Date: 2026-11-02
- Amends: 02 §5 (drag and drop: Grab)
- Code: `apps/web/src/features/list/use-list-dnd.tsx`, `apps/web/src/features/list/task-row.tsx`

## Context
A new row (a draft) had no drag handle, and presses on it never started a drag: the task doesn't exist until its title is committed (02 §3.4), so there was nothing to move. To put a task somewhere else while typing it, the user had to press Enter, leave the next empty row and then drag the new task.

## Decisions
1. **A new row's handle drags once its title has text.** The handle is hidden while the title is empty (the input shows its placeholder), so an empty row still has nothing to drag and disappears without a trace when focus leaves it.
2. **The drag creates the task first.** When the drag starts (after the usual 4 px), the title is committed as a blur would commit it: same parsing (dates, `#tags`, `@person`, `!reminders`), the task keeps the row's id, and the edit ends. The drag then moves it like any other task. Create and move are two list ops, so Undo takes back the move first, then the creation.
3. **A click on the handle without a drag** also commits the title and then selects the new task, as the handle does on any row. Chromium commits through the title's blur (the press moves focus to the handle); Safari keeps focus in the title, so both paths commit explicitly.
4. **A title that parses to nothing** (only a `#tag` or a date) creates no task, so the drag does not start.

## Keyboard
Unchanged: Enter or Esc creates the task, and Ctrl/Cmd+↑/↓ (and the other keyboard moves of 02 §5) move it. Shift+Tab from the title commits it as any blur does and leaves focus on the new task's title in Navigate; two more Shift+Tabs reach its handle (the row's tab order is handle, checkbox, title), and Space lifts it.

## Considered
- **Starting the drag from anywhere on the new row.** The row is almost all title input, where a press places the caret or selects text; only the handle drags.
- **Dragging the draft itself and creating the task at the drop.** It would need drop handling for rows that aren't tasks yet; creating first reuses the normal drag unchanged.
