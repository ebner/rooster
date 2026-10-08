# ADR 0020: Pinned phone frame

- Status: accepted
- Date: 2026-10-09
- Amends: ADR 0011 §1 (frame per breakpoint); 02 §13.1
- Code: `apps/web/src/features/shell/app-shell.tsx`, `apps/web/src/styles/theme.css` (phone-frame rules), `e2e/phone-frame.*.spec.ts`

## Context
In the installed Android PWA, the bottom navigation moved with the scroll, and after a pull-to-refresh it sat below the screen until the page was scrolled. The phone frame was an in-flow `h-dvh` column, html and body had no overflow or overscroll rules, and every scroller had `overscroll-behavior: auto`. Anything that made the document taller than the window, including a `dvh` mismatch in standalone mode, scrolled the whole frame, nav included. So did overscroll chaining from the list to the page.

Emulation could not reproduce the device trigger: Chromium can't emulate `display-mode: standalone` or Android's dynamic bottom bar. It did prove the mechanism: with content below the frame, one drag on the nav scrolled the document by 998 px.

## Decisions
1. **Pinned frame.** The phone frame is `position: fixed; inset: 0`, not an `h-dvh` element in the flow. The bottom nav stays in the flow at the frame's bottom. That makes it effectively fixed, and `main` shrinks by exactly its height.
2. **No document scroll on phones.** With `[data-frame="mobile"]`, html and body get `height: 100%`, `overflow: hidden` and `overscroll-behavior: none`. The document can never scroll.
3. **No overscroll on the scrollers.** The list scroller (`[data-list-column]`) and `main` use `overscroll-behavior-y: none`, not `contain`. The sticky header lives inside the scroller, and `contain` would still let it bounce. Our pull-to-refresh uses touch events, so it keeps working; the browser's native pull-to-refresh no longer triggers.
