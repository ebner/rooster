# ADR 0069: Long-press a new row's title to lift it on phones

- Status: accepted
- Date: 2026-11-11
- Amends: 02 §13.2 (phone rows and gestures); extends ADR 0067 to touch screens
- Code: `apps/web/src/features/list/use-list-dnd.tsx`, `title-input.tsx`, `controller.ts` (`draftCreates`)

## Context
ADR 0067 lets a new row (a draft) be dragged from its handle once its title has text: the drag commits the title first and then moves the task. Phones never got this. Every phone row lifts with a 350 ms long-press, but a new row's title is a text input, which never starts a drag, and the drag handle is hidden on touch screens. To move a task just typed on a phone, the user had to leave the row and then long-press the new task.

## Decisions
1. **On touch, a long-press on a new row's title lifts it once committing it would create a task** (`controller.draftCreates`: the same parsing and the user's cancelled tokens). It is the same long-press as on any row (350 ms, 5 px tolerance), and only where rows reorder: My tasks and the pane's subtask list, not the smart views or Everyone's tasks. Mouse, pen and an iPad stylus are unchanged: pressing in the title places the caret, and the handle drags (ADR 0067).
2. **The lift creates the task first,** exactly as ADR 0067: the input really blurs, so the keyboard closes, and the title is committed once (a blur counts as the commit in `TitleInput`, so no second path can duplicate tags or reminders). The task keeps the row's id. Create and move are two list ops; Undo takes back the move first.
3. **A blank title lifts nothing;** the press stays the system's own. Neither does a new task with a future repeat, which goes straight to the Recurring section (ADR 0068).
4. **A long-press released without moving** creates the task and enters selection mode with it selected, as on any other row (02 §13.2).
5. **Mechanics.** The touch-move listeners sit on the touch's own target (the blurred input keeps receiving the touch); the new row's extra scroll room below the list stays until the drop, so the list doesn't jump under the finger; a pull-to-refresh in progress resets when the drag starts.

## Trade-off
On a new row, a long-press on the title no longer places the caret or selects a word: it lifts the row. A tap still places the caret, and the keyboard's space-bar cursor still moves it. Rows that already exist don't change.

## Not provable in emulation
Playwright's WebKit and Android projects cover the gesture, but not the platforms' own text interaction: whether iOS's loupe or edit menu, or Android's word selection, takes the touch before 350 ms (iOS would then send `touchcancel`, and nothing lifts), and whether a browser that resizes the layout viewport when the keyboard closes cancels the drag. These need a check on real phones; if the latter shows up, `interactive-widget=resizes-visual` in the viewport meta is the fix.

## Considered
- **A grip on new rows on phones.** It keeps the title's text handling, but it is a small target that appears only on new rows; the long-press matches every other row.
