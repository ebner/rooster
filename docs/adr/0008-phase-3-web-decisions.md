# ADR 0008: Phase 3 web decisions (pane, subtasks, tags, editor)

- Status: accepted
- Date: 2026-10-05
- Refines: 02 §6 and §9, 04 §5, 10 §3.5

## Decisions
1. **Pane state lives in the URL.** A pathless `o.$orgSlug._tasks` layout renders both `/my` and `/t/:taskId`, so the list never remounts when the pane opens or closes.
2. **The list UI store is injectable** (`ListStoreContext`, `createListStore`, `controller.uiStore`). The pane's subtask list reuses the row component, controller and DnD with its own selection state.
3. **Keymap focus zones** (`list`, `pane`, `paneList`):
   - List keys act on whichever surface has focus.
   - Handlers fall through layers when they return `false`.
   - Tab chords are disabled inside `[data-no-chords]` (the description editor).
   - Undo and redo are app-wide.
4. **The pane reads optimistic list state first.** The description, and tasks that are not in My tasks, come from `['task', id]` with pending ops replayed on top. The pipeline folds confirmed ops into cached details.
5. **`#tag` handling:**
   - On create, the client sends `tagIds` plus `tagNames`.
   - On an edit or in the picker, it sends `tag.create` followed by `task.addTag`.
   - Pending tags are overlaid on `['tags', orgId]`.
6. **Settings → Tags** is a section of org settings (FR-SET-4), available to all members, using online-only mutations.
7. **Confirmations that match the optimistic view do not re-render the list.** Timestamps and `seq` are ignored for that comparison.
8. **The AC-2.12 perf test runs with Playwright tracing off.** Trace snapshots cost about 25 ms per action at 600 rows.
9. **Tag filtering** applies to top-level rows, OR across the selected tags, and lasts for the session.
10. **The pane's subtask section** shows direct children only, including completed ones. Deeper levels are reached by opening a subtask.
11. **Completing from the pane** has no 1.5 s hold. The hold exists to keep a list row in place.
12. **Markdown editor:** `onChange` fires 600 ms after the last edit, and immediately on blur, Esc, Mod+Enter or unmount. Outside value changes are applied only while the editor is not focused. Raw HTML is never parsed. Escaping is minimal, so `snake_case` and `2 * 3` round-trip unchanged. The normalisations are listed in 10 §3.5.

## Known gaps
- There is no UI path to re-parent a task yet; a "Make subtask of…" command palette action arrives in P5. AC-3.5 is covered at the API level.
- The mobile sheet header (‹ back, drag handle) comes with P4.
