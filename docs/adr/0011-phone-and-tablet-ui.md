# ADR 0011: Phone and tablet UI (Phase 4, WP 4.5–4.7)

- Status: accepted
- Date: 2026-10-05
- Refines: 02 §2 (breakpoints), §13, §15; 03 §2.6, §3.1, §3.11; FR-PWA-5, FR-SET-2

## Decisions
1. **Frame per breakpoint.** `AppShell` renders three frames from `useBreakpoint()` (`src/ui/use-media.ts`):
   - desktop: unchanged (sidebar or persisted rail);
   - tablet (768–1199): always the 56 px rail; expanding opens the full sidebar **over** the content with a scrim (Esc, a scrim tap, Mod+\ or navigation closes it). The expanded state is transient and never persisted, so a desktop choice cannot leave tablets permanently covered;
   - phone (< 768): main plus the bottom nav (My tasks · Search · Settings). Search is disabled until the palette lands (P5), like the sidebar's entry. The off-canvas drawer is gone: the header's org switcher sheet and ⋯ menu (org settings, admin, sign out, screen items) replace it.
2. **One `ViewHeader`, two looks.** On phones `ViewHeader` renders `MobileHeader` (56 px + safe area; org switcher left, sync pill and ⋯ right) when the shell provides the phone context; list screens add the view switcher (`views`, appended to by P5/P6). The h1 stays in the tree (visually hidden next to the org switcher).
3. **Swipes are a delegated pointer handler** (`features/list/swipe-rows.tsx`), not a library. Rows are `touch-action: pan-y`, so vertical pans stay native scrolling; a touch that first travels ≥ 10 px sideways (and 1.2× more than vertically) becomes a swipe. The row follows the finger through inline styles (no React render per move); a single `SwipeReveal` is drawn behind it. Commit: ≥ 30 % of the width, or a fling (≥ 0.6 px/ms over ≥ 40 px, in the direction of travel). A direction set to `none` rubber-bands. Complete and Delete slide the row out, then act (a swiped completion collapses at once: the swipe already showed it, and undo is in the toast); Date and Move spring back and open their sheet. Crossing the threshold vibrates (10 ms). Actions are announced in the list's live region.
4. **dnd-kit split by input.** The `PointerSensor` (4 px) now ignores `pointerType: touch`; touch drags belong to the `TouchSensor` (350 ms, 5 px tolerance). A swipe exceeds the tolerance before the delay, so the two never both start. A long-press released having moved < 8 px enters **selection mode** instead of "drop cancelled".
5. **Gesture ghost clicks** are swallowed for 600 ms when they land within 24 px of where the gesture ended or on the swiped row (`gestures.ts`), so a swipe that started on the checkbox never toggles it and a long-press never also opens the sheet.
6. **Selection mode** is list-store state (`selectionMode`): checkboxes become selection circles, a tap toggles, the count is announced, and a header (✕ · "n selected") plus a bulk toolbar replace the top bar and the bottom nav. Complete and Delete end the mode; Date, Move and Tag keep it (the user may continue). Deselecting the last row, Esc or growing past 768 px also ends it.
7. **Phones use bottom sheets where desktop uses popovers** (03 §3.11): `BottomSheet` (React Aria modal: focus trap, Esc, scrim, swipe-down on the handle; 250 ms slide, instant under reduced motion) with 48 px `SheetOption` rows. The list maps its existing popover state (`date`, `moveTo`, `tag`) to `QuickDateSheet`, `GroupSheet` and `TagSheet` on phones, so D / M / T and the bulk actions reach the same sheets. "Pick date…" swaps in the full `DatePanel` without focusing its text input (no keyboard).
8. **Quick dates keep the time of day** already set, matching the desktop chips.
9. **Accessory bar** (02 §13.3). The draft's title input registers a small handle (`titleInputHandle(rowId)`: next, insert, focus) so the bar can act on it from outside the row. Bar buttons prevent focus on pointer-down, so the keyboard stays up. Date and Group open sheets: the draft's edit is *suspended* (`suspendedEdit`), so the blur neither commits nor discards it, and focus returns to the title when the sheet closes. A date picked there is stored on the draft (`Draft.due`) and applied on create unless the title names one. `# Tag` inserts `#` at the caret (the existing autocomplete takes over). The bar sits at `bottom = innerHeight − visualViewport.height − offsetTop`. The FAB and the bottom nav hide while a text field has focus (focus is the reliable signal; the keyboard's size arrives late or never in emulators).
10. **Detail sheet history.** On phones, closing a sheet this session pushed steps back in history (`router.history.back()`), so ‹ back, swipe-down and the system back gesture leave the same history; otherwise (deep link) the URL is replaced as on desktop. ‹ back and swipe-down slide the sheet out first (250 ms).
11. **Tablet pane** keeps the 480 px overlay and adds a scrim (tap closes). The desktop overlay (list < 480 px) stays scrim-less.
12. **`content-visibility: auto` is desktop/tablet only.** WebKit skips painting rows of a nested scroller that are in view; phones render plainly (AC-2.12 is a desktop budget).
13. **Swipe actions setting** lives in Settings → Behaviour (FR-SET-2), stored in `user.prefs.swipeLeft/swipeRight` via `PATCH /me`. `SWIPE_ACTIONS` gains `move` (02 §13.2 lists Complete / Date / Move / Delete; `none` stays for "nothing").
14. **New tokens:** `--h-property-row-mobile` 48, `--h-bottom-nav` 64, `--h-view-switcher` 48, `--h-accessory-bar` 56, `--h-sheet-handle` 4, `--size-fab` 56, `--w-sheet-handle` 36, plus safe-area variables (`--safe-top/bottom/left/right`) and `--list-sticky-top` (where sticky group headers stop: under the desktop header or the phone header + view switcher).
15. **Keyboard parity** for the new touch paths: swipe complete = Mod+Enter, date = D, move = M, delete = Delete; FAB = Q; selection = X / Shift+click; org switch = Mod+1…9. Pull to refresh has no key (it is a reload).
16. **Deep-link selection** (02 §9.1) is an effect keyed on the task id and its presence in the list, not a one-shot ref: a cache restored before the first render (ADR 0010) and StrictMode's second mount pass used to leave the row unselected.

## Testing
- `e2e/*.mobile.spec.ts` runs in the `mobile` (iPhone 15, WebKit) and `mobile-android` (Pixel 8) projects; `e2e/support/touch.ts` dispatches pointer events for swipes, touch-like events for dnd-kit's long-press (WebKit has no `Touch` constructor), and emulates the keyboard by shrinking `visualViewport`.
- WebKit needs `pnpm --filter @rooster/web exec playwright install webkit` (and its host libraries, e.g. `libevent`, `libavif`).

## Known gaps
- Pull to refresh is not covered by e2e (synthetic touches cannot drive native overscroll); it is a thin wrapper around refetch + `syncEngine().syncNow()`.
- The comment composer above the keyboard arrives with comments (P6).
