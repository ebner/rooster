# ADR 0016: Initial bundle budget (Phase 5)

- Status: accepted
- Date: 2026-10-06
- Amends: 10 §4 (initial JS for `/o/:slug/my`: 250 KB → 450 KB gzip)
- Code: `scripts/bundle-budget.mjs` (`pnpm bundle:check`, a CI step after the build), `apps/web/src/lib/lazy.ts`, `packages/core/src/limits.ts`, `packages/core/src/sse.ts`, `packages/i18n/src/{core,lazy,catalog-en,catalog-sv}.ts`

## Context
10 §4 set 250 KB gzip, but nothing measured it. At the end of Phase 5 the route loaded 593 KB: Tiptap and ProseMirror were eager, although 10 §4 requires them to be lazy.

## Measurement
`pnpm bundle:check` reads the Vite manifest of `apps/web/dist`. It sums the gzip size (level 9) of:
- the entry;
- the route chunks on the `_app` → `_tasks` → `my` path, with their static imports;
- the larger of the two locale catalogs, which `main.tsx` awaits before the first render.

Lazy chunks are not counted. They are, however, prefetched when the browser is idle.

## Changes
| Step | Initial JS |
|---|---|
| Phase 5 as merged | 593 KB |
| The Markdown editor is lazy (`DescriptionField`) | 438 KB |
| No zod on the client: zod-free constants in `@rooster/core/limits`, zod-free SSE guards in `@rooster/core/sse` (tested against the zod schemas) | 412 KB |
| react-aria UI strings limited to en-US and sv-SE (`@react-aria/optimize-locales-plugin`, a dev dependency; no overlap with any existing one) | ~395 KB |
| One locale catalog per load (`@rooster/i18n/lazy`): the web imports `@rooster/i18n/core`, while the server, CLI and tests keep the bundled `@rooster/i18n` | ~375 KB |
| The date picker, tag picker, move-to and group-delete popovers and the better-auth client load on first use (`lazyWithPreload`) | 358 KB |
| Counting the active catalog | **370 KB** |

`InteractionPrefetch` on the tasks screen warms the lazy chunks when the browser is idle, so the first open of a popover or of the pane needs no network. In production the service worker precache covers offline use too.

## Decision
The budget is **450 KB**. What remains is the framework floor of the 04 §2 stack:

| Part | Gzip |
|---|---|
| react-dom | 65 KB |
| react-aria with react-aria-components and react-stately | ~83 KB |
| TanStack Router and Query | ~34 KB |
| i18next and the ICU parser | ~19 KB |
| dnd-kit | ~15 KB |

That is about 216 KB before any rooster code. Reaching 250 KB would mean replacing those libraries. A relaxed budget was chosen over that work (2026-10-06).

450 KB rather than 500 KB because an eagerly imported editor adds about 155 KB, and 450 KB still catches that regression.

## Rules
- Never import a module that renders a popover, the editor or other UI that appears only on interaction from code on the initial route. Use `lazyWithPreload`, and add the component to `InteractionPrefetch`.
- Web code imports constants from `@rooster/core/limits` and i18n helpers from `@rooster/i18n/core`, never values from `@rooster/core/schemas` or `@rooster/i18n`. Type-only imports are fine.
