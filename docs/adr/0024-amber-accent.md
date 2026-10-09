# ADR 0024: Amber accent instead of coral-red

- Status: accepted
- Date: 2026-10-09
- Amends: D-21 (00-overview); 03 §2 (palette, semantic colours, due dates), 02 §13.1 (FAB)
- Code: `packages/tokens/src/{tokens.css,index.ts}`, `packages/tokens/test/contrast.test.ts`, `apps/web/public/icons/*`, `apps/web/scripts/render-icons.mjs`, `apps/web/src/ui/fab.tsx`

## Context

## Decisions
1. **Palette.** The `coral-*` scale is replaced by the full Tailwind amber scale (`amber-50` moves from #FFF8EB to #FFFBEB). Danger (overdue dates, destructive buttons, errors) stays rose/crimson: that is the one place red is meant.
2. **Mapping** (ratios guarded by the contrast test):
   - bg-accent and text-accent amber-700 (white on it 5.02:1), hover amber-800 (7.09:1); bg-selected and bg-inbox amber-50; bg-accent-subtle amber-100; text-inverse-accent amber-300.
   - **Focus ring amber-700**, not amber-600: amber-600 fails 3:1 on the sidebar (n-50), bg-muted and accent-subtle. The test now checks the ring on all seven surfaces it can sit on.
   - Selection bar and drop indicator amber-600 (≥ 3:1 on bg-app, bg-selected and bg-inbox, and for the white check glyph); drop-target outline amber-400; brand amber-500 (logo, app icons, empty-state comb; never under text).
3. **Tomorrow** moves from amber-700 to a new `orange-700` (#C2410C, 5.18:1), so the accent never appears in a date label.
4. **FAB** uses bg-accent (hover bg-accent-hover) instead of bg-brand: a white "+" on amber-500 is only 2.15:1.
5. Icons (favicon, logo, wordmark, PWA PNGs) are recoloured to amber-500 and regenerated with `render-icons.mjs`.

## Consequences
Primary buttons, accent text, focus rings and warning text (the sync pill) all share amber-700; the sync pill's text label keeps it distinct.
