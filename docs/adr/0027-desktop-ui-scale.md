# ADR 0027: Rem tokens and a larger desktop UI

- Status: accepted
- Date: 2026-10-09
- Amends: 03 §2.5–2.8 (sizes are rem; px values are at scale 1); D-29/D-29a (pane widths scale)
- Code: `packages/tokens/src/{tokens.css,index.ts}`, `apps/web/src/styles/theme.css` (root font size), `apps/web/src/lib/ui-scale.ts`, `apps/web/src/state/pane-store.ts`, `apps/web/src/features/pane/split-view.tsx`, `apps/web/src/features/dates/time-field.tsx`

## Context

## Decisions
1. **Every size token is rem** (16 px = 1 rem): type and line heights, spacing, component heights, square sizes, layout widths and radii (not `--radius-full`). Borders, shadows, breakpoints, z-index and motion stay in px. `index.ts` keeps the px design values and emits rem from `cssVariables()`.
2. **The root font size is the scale:** 100 % by default, **112.5 % from 1440 px**, **125 % from 1600 px**. Each step starts at the narrowest window where the sidebar, the minimum list and the default pane still sit side by side (1404 px at 112.5 %, 1560 px at 125 %), so 1280 and 1366 px laptops keep their split view. CSS zoom was rejected: it skews pointer and layout coordinates for dnd-kit, React Aria positioning and Tiptap. Phones and tablets are unchanged. Percentages keep the browser's own default font size in play.
3. **JS layout constants follow the scale** through `uiScale()` (root font size / 16): the pane's default, minimum and maximum width, the minimum list width (`paneMode` takes it as a parameter and stays pure), and the time field's suggestion list height. Interaction thresholds (popover and tooltip offsets, gesture slop, drag distance, auto-scroll zone) stay in px.
4. A pane width the user resized is stored in CSS px as before. It is clamped against the scaled range at render; an unset width (`null`) means the scaled default.

## Consequences
- At 1920 px with the browser at 100 %, rooster looks as it did at 125 % zoom. Users who keep browser zoom on get both.
- E2E helpers that clicked at fixed offsets now target elements (`[data-drag-handle]`) or scale the offset (`uiScale(page)` in `e2e/support/p3.ts`).
- New JS that sizes layout in px must multiply by `uiScale()`.
