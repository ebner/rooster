# ADR 0055: List performance with 2,000 tasks, accessible names, the header menu

- Status: accepted
- Date: 2026-10-10
- Implements: ADR 0052 §4, §8, §9 (WPs 11.3, 11.4, 11.7)

## Performance (AC-11.4)
At 2,000 open tasks, keypress → paint p95 in the production build was 97 / 62 / 35 ms (create / move / complete). It is now 28 / 26 / 22–29 ms. Three changes, without virtualisation:

1. **The list root uses block layout** (`flow-root`, not `flex flex-col`). The browser no longer re-lays out a 2,000-item flex column on each change.
2. **Rows subscribe to the UI store by key** (`useRowUi` and `changedRowIds` in `state/list-store.ts`). A store change runs only the listeners of the rows it touches. **Any per-row UI state must go through `useRowUi`, with its fields listed in `changedRowIds`.**
3. **Task rows are rendered in chunks** (`features/list/row-chunks.tsx`).
   - Runs of about 48 rows (at most 96) sit in `role="none"` wrappers, and `content-visibility` moved from each row to the chunk. The intrinsic size comes from the row height tokens. `content-visibility` is off on the chunk holding the edited input, and it is screen-only, so printing renders every row.
   - Chunk assignment is sticky. The focused and edited rows keep their chunk, so they never remount and never lose focus or an unsaved title.
   - Group headers stay outside the chunks, so sticky headers are unchanged.
   - **Why not virtualisation:** the DOM stays complete. Keyboard navigation, drag and drop, the tree grid's rows, find-in-page, screen readers and printing behave as before.

The perf specs run against the production build (the pwa server). In the create step, the next title is typed 60 ms after Enter, so its input events aren't counted in the Enter's frame. The AC-2.12 test is unchanged.

## Accessibility (AC-11.3)
- **Accessible names (10 §5):**
  - A task row's `aria-label` reads, for example, "Book dentist, due tomorrow, not completed, 2 of 5 subtasks".
  - The focused title carries the same text after its own as `aria-description`, an attribute, so the row's text content is unchanged.
  - Group headers read "Today, group, 3 tasks" with `aria-expanded`.
  - The code is in `features/list/row-name.ts`, with en and sv strings in `list.a11y.*`.
- **axe:** `e2e/a11y.spec.ts` (desktop) and `e2e/a11y.mobile.spec.ts` (iPhone and Pixel) run WCAG 2.2 AA over every screen, light only. Phone list screens are checked scrolled to the end, where the bottom padding keeps every row clear of the FAB.
- **While the phone detail sheet is open**, the list and the frame behind it are `inert`.
- **Keyboard-only journey:** `e2e/keyboard-journey.spec.ts`.
- **Manual pass:** `docs/accessibility-checklist.md`, with VoiceOver on macOS and iOS and NVDA + Firefox, run per release by the maintainer.

## The header ⋯ menu and the Behaviour settings (WP 11.7)
- **Items per view:**
  - My tasks: Add group, Show completed, Collapse all groups (Shift+←), Expand all groups (Shift+→), Export JSON or Markdown, and Print (Mod+P).
  - Smart views drop the group items.
  - Everyone's tasks has Export and Print.
- **On phones**, the same items lead the existing header ⋯ popover.
- **Printing:** the tasks screen marks `<html data-print="list">`, and `styles/print.css` prints only the list. Its `:has()` rules apply under `@media print` only.
- **"Until reload"** is stored as `prefs.completeHideMs = 10000`, the schema maximum (`features/list/hide-delay.ts`). An older client treats it as a 10-second hold, which is safe, and 0 keeps meaning "at once". The web keeps a completed row, with no timers, until you switch org or view, or reload.
