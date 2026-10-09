# ADR 0026: One brand drawing: the "Print" rooster head

- Status: accepted
- Date: 2026-10-09
- Amends: 03 §2.10 (Brand); 02 §14 (empty-state illustration)
- Code: `apps/web/src/ui/brand.ts` (geometry), `apps/web/src/ui/logo.tsx` + `logo.css` (`LogoMark`, `Wordmark`, `Logo`), `apps/web/scripts/render-icons.mjs`, `apps/web/public/icons/*`, `apps/web/index.html` (loading screen), `apps/web/src/routes/__root.tsx` (404 and error pages)

## Context
The brand was three unrelated drawings: a filled geometric glyph (favicon, app icons, rail), a wordmark whose letters were assembled from strokes, and a full-body line rooster in the empty views. The phone header, the 404 page and the loading moment showed no brand, and the app icon (white glyph on amber) was low in contrast. The goal was one coherent identity, a more distinctive mark based on the line rooster and focused on the head, a draw-in where the comb is painted on primary placements only, and a better-looking name. Three marks and four typefaces were proposed in a review page, and the choice was the recommended "Print" mark, the Fraunces wordmark and the ink app-icon tile.

## Decisions
1. **One source.** `brand.ts` holds the mark (line, paint areas with their brush masks, eye, small cut, optical centring) and the outlined wordmark. The React components render it inline; `render-icons.mjs` imports the same module (Node strips the types) and writes every static file. The icons can no longer drift from the app.
2. **Mark.** One unbroken ink line on a 48 grid, with the comb and wattle in amber-500, offset from the line like a screenprint. Below 24 px a heavier, tighter small cut is used, because the 3.5-unit line goes blurry at favicon size.
3. **Wordmark.** Fraunces (OFL) at weight 620, optical size 96, SOFT 100, WONK 1, shaped with HarfBuzz (kerning included) and outlined to a 117 × 23 path. No font file ships, and it renders identically everywhere.
4. **Draw-in.** A CSS sequence: the line draws itself (stroke-dashoffset on a `pathLength=1` path), the eye pops, and brush strokes inside SVG masks paint the comb, then the wattle. The timing is two new tokens (`--dur-logo-line` 900 ms, `--dur-logo-paint` 550 ms) plus `--dur-pop`; under reduced motion the tokens are 0 and the animation is off. `LogoMark animated` plays once per page load (a module flag), so moving between the signed-out screens doesn't replay it; `animated="always"` exists for the kitchen sink.
5. **Placement** is fixed in 03 §2.10. The draw-in runs only on the signed-out screens. The loading screen is a static `<img>` of `logo-stack.svg` inside `#root`, which the first render replaces. The root 404 page and a new root error page (with Reload) carry the logo, because they sit outside the app frame. Empty views use the muted mark instead of a separate illustration.
6. **App icons** are an ink (n-900) tile with a white line and an amber comb. The favicon has a transparent background, and its line turns white under `prefers-color-scheme: dark` so it stays visible on dark tab strips.
7. Sizes are given in px at scale 1 and rendered in rem, so the logo follows the desktop UI scale (ADR 0027).

## Consequences
- The `--w-illustration` token is no longer used by the empty view (it uses a 96 px mark); it stays as the size limit for future illustrations.
- Changing the mark means editing `brand.ts` and rerunning `render-icons.mjs`.
