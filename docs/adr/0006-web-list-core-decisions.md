# ADR 0006: Web list-core decisions (Phase 2)

- Status: accepted
- Date: 2026-10-05
- Refines: 02 §3–§6, 04 §5.3 and §6.2

## Decisions
1. **Tab chords:**
   - Inside the list, Tab `keydown` is always prevented.
   - When Tab is released without a chord, native focus movement is emulated in the 02 §6 tab order: handle → title → date cell → next row.
   - The original wording in 04 §5.3 ("prevent Tab only when a chord fires") cannot work, because focus has already moved by then. 04 §5.3 is updated.
2. **Backspace-on-empty protection:**
   - List payloads omit descriptions, so a task counts as "known empty" only if it was created in this session.
   - Backspace on the emptied title of an older task shows the Tab+Delete hint instead of deleting it.
   - Phase 3, which loads task details, may relax this.
3. **Colon-to-group on a draft at the top of a group:**
   - The split contract (`splitAfterTaskId`) cannot express "split before the first task".
   - The new group then takes the whole group's tasks, via create plus bulk move, recorded as **one** undo entry.
4. **Keyboard moves** ("Move to…", Ctrl+Shift+↑/↓) land at the **top** of the target group and skip collapsed groups.
5. **Collapse and expand** are persisted, but they are not undoable operations.
6. **The optimistic cache** is always the last server-confirmed state with the pending ops replayed on top. Server replies and refetches never overwrite a newer optimistic edit.
7. **Redo** is recomputed at undo time. Redoing a create restores the same task (same ID) instead of creating a new one.
8. **TanStack Query notifications flush synchronously** (`apps/web/src/router.ts`), so a keypress renders once. This is required for the 50 ms budget (AC-2.12).
9. **Drag and drop** uses one dnd-kit draggable for the whole grid. The drop target is computed from the row under the pointer, which keeps a 500-row list fast.
10. **The AC-2.12 performance test** runs in its own Playwright project after the others, so parallel workers do not skew the measurements.
