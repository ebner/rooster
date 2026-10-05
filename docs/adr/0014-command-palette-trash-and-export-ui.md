# ADR 0014: Command palette, Trash and export UI (Phase 5, WP 5.3, 5.4 web)

- Status: accepted
- Date: 2026-10-05
- Refines: 01 FR-VIEW-3/4, FR-SET-5; 02 §6, §12, §13.1; 03 §3.11; 04 §5.3; ADR 0008 (the "Make subtask of…" deferral), ADR 0011 (the disabled Search tab)
- Code: `apps/web/src/features/palette/`, `features/settings/data-page.tsx`, `data/{search,trash,export}.ts`, `keymap.ts`, `use-keymap.ts`

## Decisions
1. **Palette actions come from the keymap registry.**
   - Entries have an optional `palette` group (`task`, `list`, `navigation`, `general`).
   - Palette-only commands are registry entries with `keys: []` and scope `palette`: `makeSubtaskOf`, `openTrash`, `exportData`, `openOrgSettings` and `openAdmin`. The cheat sheet skips keyless entries.
   - `runShortcut(id)` in `use-keymap.ts` runs the same handler layers as the key would, with a synthetic event whose target is the element that was focused before the palette opened. `hasShortcutHandler(id)` hides actions that do not apply.
   - The palette closes and restores focus before running a command, so anchored popovers (Move, Date) open at the row.
   - Navigation actions navigate directly when no handler is mounted.
2. **Commands that take an argument** go through `features/palette/commands.ts`: the list screen publishes `{orgId, selectedTaskIds, makeSubtaskOf}`. "Make subtask of…" switches the palette to a task picker in the same org, excluding the selection and its descendants. Backspace on an empty input goes back.
3. **Modes.**
   - Mod+K toggles the palette.
   - `/` opens it in search mode, which shows recents only and no actions until `>`. An empty query without recents shows a grammar hint.
   - Fuzzy-matched actions follow the task hits, with at most five when there are hits.
4. **Recents** are the last 8 tasks opened, recorded from the URL `/o/:slug/t/:id` (no coupling to the pane). They are stored per user and device in `localStorage` (wrapped in try/catch). Titles come from the cache, falling back to the stored title; tasks deleted locally are skipped.
5. **Highlights.** Titles mark the matched prefix on the client, the same way as offline. FTS5 marks whole words, so the server snippet is shown only for description or comment matches.
6. **Offline,** or when `GET /search` fails, the palette filters every cached `['my-list', *]` with `parseSearchQuery` + `matchesTask` (titles only) and says "Offline — showing cached tasks". The palette chunk is lazy (about 8 KB gzip) and prefetched at idle, so it opens offline even before the service worker has cached it.
7. **The phone Search tab** opens the palette as a full-screen sheet (Cancel, 44 px rows, keyboard-inset padding), not a `BottomSheet`.
8. **Settings → Data** (`/settings/data?org=<slug>`) has an org picker.
   - Export JSON and Markdown are plain `<a download>` links to the export URL, disabled while offline.
   - Trash is paged (newest first) with Restore and Delete permanently. The delete confirms inline (focus moves to Cancel); there is no modal.
   - ↑/↓ move between Trash rows and keep the button column. Enter never fires an action implicitly.
9. **Trash restore** is a plain mutation that then invalidates `['trash', orgId]` and `['my-list', orgId]`, rather than a pipeline op. The core `restoreTask` reducer only restores tasks held in the local `deletedTasks`, and Trash items generally are not, so an optimistic restore would be a no-op. Permanent delete is online-only too.

## Spec conflict
- 03 §3.11 puts the active palette row on `--color-bg-muted`, but `date-today` (green-700) on bg-muted is 4.4:1 and fails axe. The active row uses `bg-subtle` plus the accent edge bar. 03 should be amended (Phase 5 close-out).
