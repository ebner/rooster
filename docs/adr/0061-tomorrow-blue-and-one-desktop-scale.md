# ADR 0061: Tomorrow in blue, and one desktop scale step

- Status: accepted
- Date: 2026-10-13
- Amends: 03 §2.1 and §2.3 (the "tomorrow" colour), ADR 0024 §3; 03 §2.5 and ADR 0027 §2 (the UI scale)
- Code: `packages/tokens/src/{tokens.css,index.ts}`, `apps/web/src/styles/theme.css`, `apps/cli/test/output.test.ts`

## Context
- **Tomorrow:** ADR 0024 moved "tomorrow" from amber-700 to orange-700 (#C2410C) to keep the accent out of date labels. At label size that orange reads as red, the same as overdue's rose-700 (#BE123C), although a task due tomorrow needs no alarm. The CLI's 16-colour fallback even maps both to ANSI red (31).
- **Scale:** ADR 0027 raised the root font size to 112.5 % from 1440 px and 125 % from 1600 px. On wide screens the 125 % step turned out too large: the UI read best at about 112.5 % of the design size there too.

## Decisions
1. **"Tomorrow" is blue-700** (#1D4ED8, 6.70:1 on white), which is already in the palette for info text. The order reads as a calm progression: overdue red (with its icon and weight), today green, tomorrow blue, this week violet, later grey. Teal was rejected as too close to today's green, and amber-800 as the accent's hover colour. The CLI follows from the token (ANSI 34 in 16 colours). `orange-700` has no other use and is removed from the palette.
2. **The root font size is 100 % below 1440 px and 112.5 % from 1440 px**; the 125 % step at 1600 px is dropped. A wide screen at 100 % zoom now gets 112.5 %. Phones, tablets and narrow desktops are unchanged, and 1440 px windows (the guide's screenshots) look the same as before. The `wide` breakpoint (1600 px) stays for layout.

## Consequences
- Users who zoomed out to compensate can return to 100 %; those who liked 125 % can zoom in to about 110 %.
- Pane widths follow `uiScale()` as before, so no stored width needs migrating.
