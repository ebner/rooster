# 03: Design System ("Coop")

> The rooster design system is called **Coop**. It is **binding** for every UI change. Components consume **semantic tokens only**; raw palette values may appear only in `packages/tokens`. A pull request that introduces a hard-coded colour, font size, spacing value, radius, shadow or duration in a component is non-compliant.

Direction (D-20, D-21, D-28): **calm and airy**. Cool neutrals, generous whitespace, one warm coral accent used sparingly, and Geist typography. Content (task titles) is the loudest thing on screen; chrome is quiet.

## 1. Design principles

1. **Quiet chrome, loud content.** Borders are hairline or absent. Separation comes from whitespace and subtle backgrounds, not boxes.
2. **Accent is scarce.** Coral marks the brand, the primary action, focus, the current selection and drop targets. It is never decoration. A screen typically shows the accent in at most 3 places.
3. **Meaning is never colour-only.** Overdue has an icon and a heavier weight. Selection has a background and an edge bar. Sync state has text.
4. **Stable geometry.** Hover never shifts layout. Hover affordances (drag handle, "+", "⋯") occupy reserved space and only change opacity.
5. **Motion explains state change.** It is short (≤ 300 ms) and never decorative. Everything respects `prefers-reduced-motion`.

## 2. Tokens

Tokens are defined in `packages/tokens/src/tokens.css` as CSS custom properties on `:root`. They are mapped into Tailwind v4 through `@theme` in `apps/web/src/styles/theme.css`, and also exported as TS (`packages/tokens/src/index.ts`) for the TUI and for email templates. Light theme only in v1 (D-22). A future dark theme only redefines the semantic layer under `[data-theme="dark"]`.

### 2.1 Palette (raw: only referenced by semantic tokens)

**Neutral (cool grey)**

| Token | Hex | Token | Hex |
|---|---|---|---|
| `--n-0` | #FFFFFF | `--n-400` | #9AA3B0 |
| `--n-25` | #FBFCFD | `--n-500` | #636B78 |
| `--n-50` | #F6F7F9 | `--n-600` | #4E5663 |
| `--n-100` | #EEF0F3 | `--n-700` | #3A404A |
| `--n-200` | #E2E5EA | `--n-800` | #262A31 |
| `--n-300` | #CDD2DA | `--n-900` | #16191E |

**Coral (brand accent)**

| Token | Hex | Use |
|---|---|---|
| `--coral-50` | #FFF3F1 | selected row background |
| `--coral-100` | #FFE3DF | Inbox header tint, NL highlight |
| `--coral-200` | #FFC9C2 | — |
| `--coral-300` | #FFA197 | — |
| `--coral-400` | #FA766A | drop indicator on hover |
| `--coral-500` | #EF4F45 | brand, focus ring, selection bar, FAB |
| `--coral-600` | #D93A31 | primary button background, accent text (4.57:1 on white) |
| `--coral-700` | #B42D26 | primary hover/pressed, link hover |
| `--coral-800` | #8F251F | — |
| `--coral-900` | #6E1F1A | — |

**Functional hues**

| Token | Hex | Notes |
|---|---|---|
| `--green-50` / `--green-600` / `--green-700` | #EEFBF2 / #16A34A / #15803D | success, completed checkbox, "today" |
| `--amber-50` / `--amber-500` / `--amber-700` | #FFF8EB / #F59E0B / #B45309 | warning, offline pending, "tomorrow" |
| `--violet-700` | #6D28D9 | "this week" |
| `--rose-50` / `--rose-600` / `--rose-700` | #FFF1F3 / #E11D48 / #BE123C | **danger and overdue** (crimson, clearly distinct from coral) |
| `--blue-50` / `--blue-700` | #EFF6FF / #1D4ED8 | info, links in descriptions |

### 2.2 Semantic tokens (components use these)

| Token | Value | Purpose |
|---|---|---|
| `--color-bg-app` | n-0 | main list background |
| `--color-bg-sidebar` | n-50 | sidebar |
| `--color-bg-subtle` | n-50 | row hover, input background (rest), table zebra |
| `--color-bg-muted` | n-100 | pressed, active nav item, skeleton |
| `--color-bg-elevated` | n-0 | popovers, pane, sheets, palette |
| `--color-bg-selected` | coral-50 | selected row(s) |
| `--color-bg-accent` | coral-600 | primary buttons |
| `--color-bg-accent-hover` | coral-700 | |
| `--color-bg-accent-subtle` | coral-100 | Inbox header, NL token highlight, drop-target group header |
| `--color-bg-success-subtle` | green-50 | swipe-complete reveal (with green-600 icon) |
| `--color-bg-warning-subtle` | amber-50 | offline pill |
| `--color-bg-danger-subtle` | rose-50 | destructive confirm popover, error toast |
| `--color-text` | n-900 | titles, body |
| `--color-text-secondary` | n-600 | group header counts, property values |
| `--color-text-muted` | n-500 | labels, placeholders, breadcrumbs, timestamps (5.4:1 on white, ≥ 4.9:1 on n-50 and coral-50). **On `--color-bg-accent-subtle` (coral-100) and `--color-bg-muted` use `--color-text-secondary` instead.** |
| `--color-text-disabled` | n-400 | disabled only (decorative contrast) |
| `--color-text-on-accent` | n-0 | text on coral-600 |
| `--color-text-accent` | coral-600 | links in chrome, active bottom-nav tab (on white only; 4.57:1). Never on n-100 or tinted backgrounds. |
| `--color-text-danger` | rose-700 | |
| `--color-text-success` | green-700 | |
| `--color-border` | n-200 | hairlines: pane edge, popover border, input border |
| `--color-border-strong` | n-300 | checkbox outline, input hover |
| `--color-border-focus` | coral-500 | focus ring |
| `--color-selection-bar` | coral-500 | 2 px left bar on selected rows |
| `--color-drop-indicator` | coral-500 | DnD insertion line |
| `--color-check-done` | green-600 | completed checkbox fill |
| `--color-overlay` | rgb(22 25 30 / 0.32) | mobile sheet scrim, tablet pane scrim |

### 2.3 Due-date semantics

The date label colour is set by `dueState()` in `packages/core`. The same function is used by web, TUI and emails.

| State | Condition | Text token | Weight | Extra non-colour cue |
|---|---|---|---|---|
| `overdue` | due < today, or due today with a time already past | rose-700 | 500 | `circle-alert` icon (12 px) before the label |
| `today` | due = today | green-700 | 500 | — (the label "Today" itself) |
| `tomorrow` | due = today + 1 | amber-700 | 400 | label "Tomorrow" |
| `thisWeek` | today + 2 … today + 6 | violet-700 | 400 | weekday label |
| `later` | > today + 6 | n-600 | 400 | — |
| `done` | task completed | n-400 | 400 | strikethrough row |
| `start-range` | has a start date | per due state | — | "Oct 10 – 12" |

Because the brand accent is red-ish (D-21), **overdue never uses coral**. It uses rose-700 plus the icon plus weight 500. Coral never appears in date labels.

### 2.4 Tag palette (10 colours, chip = bg + fg)

| Name | bg | fg | | Name | bg | fg |
|---|---|---|---|---|---|---|
| gray | #EEF0F3 | #3A404A | | teal | #DDF6F3 | #0F5F58 |
| red | #FFE4E6 | #9F1239 | | blue | #E0EDFF | #1E40AF |
| orange | #FFEAD5 | #9A3412 | | indigo | #E6E8FF | #3730A3 |
| amber | #FEF3C7 | #92400E | | purple | #F1E8FF | #6B21A8 |
| green | #DCFCE7 | #166534 | | pink | #FCE7F3 | #9D174D |

All pairs are ≥ 4.5:1. New tags get the next colour in round-robin order.

### 2.5 Typography

- **Fonts:** `Geist` (variable, 400–600) and `Geist Mono` (variable), self-hosted via `@fontsource-variable/geist` and `@fontsource-variable/geist-mono`. Fallbacks: `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` and `ui-monospace, "SF Mono", Menlo, monospace`.
- **Numerals:** `font-variant-numeric: tabular-nums` on dates, counts and times. `font-feature-settings: "ss01"` is off; keep Geist defaults.

| Token | Size / line height | Weight | Use |
|---|---|---|---|
| `--text-xs` | 12 / 16 | 400–500 | counters, badges, kbd hints, chip text |
| `--text-sm` | 13 / 20 | 400–500 | date cell, property labels, sidebar items, toasts, breadcrumbs |
| `--text-base` | 14 / 20 | 400 | **task title (desktop)**, body UI, inputs (desktop) |
| `--text-md` | 16 / 24 | 400 | **task title (mobile)**, all inputs on touch devices (prevents the iOS zoom on focus), description body |
| `--text-group` | 16 / 24 | 600 | group headers |
| `--text-lg` | 20 / 28 | 600 | view title in the header, settings section titles |
| `--text-xl` | 24 / 32 | 600 | pane title |
| `--text-2xl` | 30 / 38 | 600 | empty-state headline, onboarding |

Letter spacing: −0.011em at 20 px and above, 0 below. The description editor uses `--text-md`, a max line length of about 72 ch, and heading sizes H1 20, H2 18, H3 16 (600 weight).

### 2.6 Spacing, sizing, radius, elevation

- **Spacing scale (4 px base):** `0, 0.5=2, 1=4, 1.5=6, 2=8, 3=12, 4=16, 5=20, 6=24, 8=32, 10=40, 12=48, 16=64`. Use only these.
- **Control heights:** `--h-control-sm` 28, `--h-control` 32, `--h-control-lg` 40, `--h-row` **40** (desktop task row), `--h-row-mobile` **52**, `--h-group` 44 (desktop) / 48 (mobile).
- **Radius:** `--radius-xs` 4 (chips, NL highlight 2), `--radius-sm` 6 (buttons, inputs, rows on hover), `--radius-md` 8 (popovers, menus, toasts), `--radius-lg` 12 (palette, sheets top corners, cards), `--radius-full`.
- **Shadows** (cool tinted; the rgb channels below are fixed and only the alpha varies):

| Token | Value | Use |
|---|---|---|
| `--shadow-sm` | `0 1px 2px rgb(22 25 30 / .06)` | FAB rest, hover cards |
| `--shadow-md` | `0 4px 12px rgb(22 25 30 / .08), 0 1px 3px rgb(22 25 30 / .06)` | popovers, menus, toasts |
| `--shadow-lg` | `0 12px 32px rgb(22 25 30 / .12), 0 2px 6px rgb(22 25 30 / .08)` | palette, drag preview, bulk bar |
| `--shadow-pane` | `-1px 0 0 var(--color-border)` | split pane edge (a hairline, not a blur) |

- **Z-index:** base 0 · sticky headers 10 · sidebar 20 · pane 30 · popover/menu 40 · bulk bar 45 · toast 50 · palette 60 · drag overlay 70.

### 2.7 Motion

| Token | Value |
|---|---|
| `--dur-fast` | 120 ms (hover, crossfade) |
| `--dur-base` | 180 ms (pane slide, popover in) |
| `--dur-slow` | 250 ms (sheet, row collapse) |
| `--dur-pop` | 300 ms (checkbox completion pop) |
| `--ease-standard` | cubic-bezier(0.2, 0, 0, 1) |
| `--ease-exit` | cubic-bezier(0.4, 0, 1, 1) |
| `--ease-spring` | cubic-bezier(0.34, 1.56, 0.64, 1) (checkbox pop only) |

`@media (prefers-reduced-motion: reduce)`: all durations become 0 ms, except opacity fades capped at 80 ms.

### 2.8 Breakpoints

`--bp-tablet: 768px`, `--bp-desktop: 1200px`, `--bp-wide: 1600px`. Layout rules are in 02 §2. The list maximum width is **1040 px** (D-29a). Side gutters in main are 32 px on desktop, 24 px on tablet and 12 px on mobile.

### 2.9 Iconography

- **Lucide** (`lucide-react`), stroke width 1.75. Sizes: 16 px in rows and controls, 20 px in sidebar and nav, 24 px for the bottom nav and FAB.
- Icons inherit `currentColor`. Never use filled icon variants, except for the completed checkbox and the active bottom-nav item (filled where Lucide supplies an equivalent, otherwise accent colour).
- Standard mapping:

| Concept | Icon |
|---|---|
| My tasks | `list-checks` |
| Today | `sun` |
| Next 7 days | `calendar-range` |
| Overdue | `circle-alert` |
| No date | `calendar-off` |
| Everyone | `users` |
| Inbox (notifications) | `bell` |
| Inbox group | `inbox` |
| Search | `search` |
| Settings | `settings` |
| Drag | `grip-vertical` |
| Repeat | `repeat` |
| Attachment | `paperclip` |
| Comments | `message-square` |
| Subtasks | `list-tree` |
| Tag | `hash` |
| Due date | `calendar` |
| Offline | `cloud-off` |
| Syncing | `refresh-cw` (spinning, not under reduced motion) |

### 2.10 Brand

- **Name:** "rooster", always lower-case in the wordmark. In running text, "Rooster" is acceptable at the start of a sentence.
- **Logo mark:** a geometric rooster head in profile built from three overlapping circles (the comb, 3 lobes), a triangular beak and one dot eye. It is a single colour (coral-500) on light backgrounds and white on coral. The grid is 24 × 24 with a 2 px minimum stroke. It must stay legible at 16 px (favicon).
- **App icon:** a coral-500 rounded square (iOS mask) with the white mark centred at 60 % size. A maskable variant has a 20 % safe zone.
- **Assets** (Phase 0 deliverable): `apps/web/public/icons/{favicon.svg, icon-192.png, icon-512.png, maskable-512.png, apple-touch-icon-180.png}`, plus `logo.svg` and `wordmark.svg`.
- **Illustrations:** n-300 line art with a single coral detail, used only in empty states. At most 160 px.

## 3. Components

All components live in `apps/web/src/ui/`. Each has a variant API built with `cva` (class-variance-authority), uses Tailwind classes mapped to tokens, and has an entry in the dev-only **kitchen sink** route `/_dev/ui` that shows every state (rest, hover, focus, active, disabled, loading, error). Accessible primitives come from **React Aria Components** (menus, listbox, popover, dialog, date picker internals, toast region, grid list where used). Do not hand-roll focus management for these.

### 3.1 TaskRow (the most important component)

```
│◦◦│ ◯ │ Reply to Anna about invoice  #mail  ▸2/5  💬3 │      Today │
 16   24  gap 8                                  meta gap 8   date 112
```

| Part | Spec |
|---|---|
| Height | 40 px desktop, 52 px mobile. Padding 0 12 px. The title is vertically centred. |
| Drag handle | 16 px column at the far left, `grip-vertical` in n-400. Opacity 0, becoming 1 on row hover or keyboard focus within the row. Hidden on touch. |
| Checkbox | A **round** 18 px circle with a 1.5 px `--color-border-strong` outline. On hover, the outline is n-500 and a faint ✓ shows in n-400. When done, it is filled `--color-check-done` with a white ✓ and pops (scale 1 → 1.2 → 1, 300 ms, spring). The hit area is 32 × 32 on desktop and 44 × 44 on mobile. |
| Title | `--text-base` (mobile `--text-md`), `--color-text`, single line with ellipsis in Navigate. In Edit it is an input with the same metrics, so there is no layout shift. A done title is struck through and uses `--color-text-muted`. |
| Breadcrumb (for a subtask shown at top level) | Muted `--text-sm`, "Parent title ›", max 30 % of the width with ellipsis, before the title. |
| Meta | After the title, gap 8 px: tag chips (max 3, then "+N"; mobile max 1), subtask counter `list-tree 2/5`, comment count, `paperclip`, `repeat`, assignee avatar (20 px, only when applicable). All are `--text-xs`, `--color-text-muted`. |
| Date cell | Right-aligned in a 112 px column, `--text-sm`, tabular, colour per §2.3. Empty shows a calendar icon at opacity 0, becoming 0.6 on row hover. |
| States | **Hover:** `--color-bg-subtle`, `--radius-sm`. **Selected:** `--color-bg-selected` plus a 2 px `--color-selection-bar` on the left edge (inside the radius). **Focus-visible:** focus ring (§3.12). **Dragging source:** 40 % opacity. **Done-pending-hide:** done styles, then a height collapse over `--dur-slow`. |
| Subtask level | Indented 24 px per level. A chevron (`chevron-right`, 16 px) on parents sits in the checkbox gutter's left. The subtask row height is 36 px on desktop. |

### 3.2 GroupHeader
Height 44 px, top margin 24 px (except the first), `--text-group`.
- Content, in order:
  - Chevron 16 px (rotates 90° when expanded, 120 ms)
  - Name
  - Count in `--text-sm` `--color-text-muted`, tabular, 8 px after the name
  - On hover only, right-aligned: "+" and "⋯" icon buttons, 28 px each
- No background at rest. On hover, a subtle background appears.
- **Inbox variant:** `--color-bg-accent-subtle` background, `--radius-md`, an `inbox` icon before the name, and the hint text in `--text-sm` `--color-text-secondary` (muted fails contrast on coral-100).
- **Drop-target state** (dragging over a collapsed group): accent-subtle background plus a 1 px coral-400 inset outline.
- The header sticks to the top of the scroll container (`position: sticky`) while its group is in view, with a background equal to the app background.

### 3.3 AddRow ("+ Add task" / "+ Add group" / "+ Add subtask")
The same height and left alignment as the title text. `plus` icon plus text in `--color-text-muted`. On hover, the text becomes `--color-text-secondary`. Clicking it turns it into a draft TaskRow.

### 3.4 DateCell and DatePopover
See 02 §7.
- Popover: 320 px wide, `--radius-md`, `--shadow-md`, 12 px padding.
- Calendar grid cells: 36 px square, `--radius-sm`.
  - Today: a 1.5 px coral-500 ring.
  - Selected: coral-600 fill with on-accent text.
  - Range in-between: coral-50 fill.
  - Weekend columns: muted text.
- Quick chips are buttons in `secondary` size `sm`, with the key hint in `Kbd`.

### 3.5 Buttons

| Variant | Rest | Hover | Use |
|---|---|---|---|
| `primary` | bg-accent, text-on-accent | bg-accent-hover | one per surface max |
| `secondary` | bg-elevated, 1 px border, text | bg-subtle | default |
| `ghost` | transparent, text-secondary | bg-subtle | toolbars, row actions |
| `danger` | rose-600 bg, white text | rose-700 | destructive confirm |
| `link` | text-accent, no padding | underline | inline |

- Sizes: `sm` 28 px / `--text-sm` / 8 px horizontal padding; `md` 32 px / `--text-sm` / 12 px; `lg` 40 px / `--text-base` / 16 px.
- `IconButton` is square, the same heights, ghost by default, and **must** have `aria-label` plus a tooltip.

### 3.6 Inputs
- Height 32 (desktop) or 44 (mobile), `--radius-sm`, 1 px `--color-border`, `--color-bg-app` background.
- Hover: border-strong. Focus: focus ring with the border becoming coral-500.
- Placeholder: `--color-text-muted`.
- Error: rose-600 border plus a 13 px message below.
- **Inline title inputs are borderless** (they look like text).

### 3.7 Chips & tags
Height 20 px, `--radius-xs`, 6 px horizontal padding, `--text-xs`, weight 500, tag palette colours. A removable chip shows an `x` icon (12 px) on hover. In the row, chips are not interactive (a click opens the tag popover).

### 3.8 Popover / Menu / Tooltip
- **Popover and menu:** bg-elevated, 1 px border, `--radius-md`, `--shadow-md`, 4 px inner padding. Menu items are 32 px tall with `--radius-sm`, an icon 16 plus a label, and a right-aligned `Kbd` hint. They enter with fade plus a 4 px translate over 180 ms.
- **Tooltip:** n-900 background, white `--text-xs`, 4 × 8 px padding, `--radius-sm`, 500 ms open delay and 0 ms when moving between tooltipped items. It always includes the keyboard shortcut in a `Kbd` when one exists.

### 3.9 Toast
- Bottom-left (desktop) or above the bottom nav (mobile). Width 360 max. n-900 background, white text `--text-sm`, `--radius-md`, `--shadow-md`.
- An optional single action button: text in coral-300, weight 600.
- Danger variant: a rose `circle-alert` icon.
- At most 3 stacked; new toasts appear at the bottom.
- `role="status"` (polite) for info and `alert` for errors.

### 3.10 Sidebar items
- Height 32, `--radius-sm`, 8 px horizontal padding, icon 20 plus a `--text-sm` label, with the count right-aligned and muted.
- Active: `--color-bg-muted`, with the label in `--color-text` weight 500.
- Org section header: 12 px uppercase-free label in `--text-xs` weight 600 `--color-text-muted`, avatar 16, "⋯" on hover.
- The Overdue count uses rose-700 text, shown only when > 0.

### 3.11 Detail pane, sheets, palette, bulk bar
- **Pane:** bg-elevated, `--shadow-pane`.
  - Toolbar 48 px with a bottom border.
  - Content padding 24 px.
  - Property grid rows 36 px, with the label column 112 px in `--text-sm` muted.
- **Mobile sheet:** full-screen. The header is 56 px with ‹ back, a centred drag handle (36 × 4, n-300, radius full) and an actions "⋯".
- **Bottom sheet** (quick date, org switcher): top `--radius-lg`, max height 70 %, scrim `--color-overlay`, slides up 250 ms.
- **Palette:** 640 px wide, `--radius-lg`, `--shadow-lg`, input 48 px tall `--text-md`, result rows 40 px, and the active result in `--color-bg-muted` with an accent left bar.
- **Bulk bar:** floating bottom-centre with a 24 px offset, n-900 background, white text, `--radius-lg`, `--shadow-lg`, height 48. Its buttons are ghost-inverse.

### 3.12 Focus
`:focus-visible` gets `outline: 2px solid var(--color-border-focus); outline-offset: 2px; border-radius: inherit`. A TaskRow in Navigate uses an **inset** ring (`outline-offset: -2px`) so it doesn't overlap the neighbouring rows. Focus is never removed without a replacement.

### 3.13 Avatars
Circle; sizes 16 / 20 / 24 / 32 / 40. The image comes from OIDC `picture` or an upload. The fallback is initials on a tag-palette background, chosen by a hash of the user ID. The org avatar is a rounded square (`--radius-xs`) with emoji or initials.

### 3.14 Kbd
Inline `Geist Mono` `--text-xs`, 1 px border n-300, a bottom border of 2 px, `--radius-xs`, 0 × 4 px padding, n-50 background. Platform-aware: the label renders "⌘" on macOS/iOS and "Ctrl" elsewhere.

### 3.15 Sync pill
24 px tall, `--radius-full`, `--text-xs` weight 500. States:
- Offline: neutral with `cloud-off`.
- Pending: amber-50 background, amber-700 text and "· 3".
- Syncing: a `refresh-cw` spin.
- Error: rose-50 background, rose-700 text, clickable "Retry".

### 3.16 Skeleton
n-100 blocks with `--radius-xs`. Title widths vary between 40 % and 75 % (deterministic per index). Shimmer is a 1.2 s linear gradient sweep, which is off under reduced motion.

## 4. Content & voice

- **Tone:** brief, friendly and plain. No exclamation marks, except in the empty-state celebrations ("Nothing due today 🎉").
- **Sentence case** everywhere ("Add task", not "Add Task").
- **Verbs on buttons:** "Delete group", not "OK".
- **Swedish:** use natural Swedish UI conventions ("Lägg till uppgift", "Idag", "Klar", "Grupp"). Avoid literal anglicisms. The glossary for consistent terms (EN → SV) is:
  - task → uppgift
  - group → grupp
  - inbox → inkorg
  - organisation → organisation
  - due date → förfallodatum (label) / "Datum" (short)
  - subtask → deluppgift
  - tag → tagg
  - comment → kommentar
  - follower → följare
  - assignee → ansvarig
  - Everyone's tasks → Allas uppgifter
  - smart view names: Idag, Kommande 7 dagar, Försenade, Utan datum
- All strings live in `packages/i18n/locales/{en,sv}/*.json`. Keys are namespaced (`list.addTask`), with ICU plural forms (`{count, plural, one {# task} other {# tasks}}`).

### Contrast rule (applies to all tokens in §2)
Every text and background pair used must be ≥ 4.5:1, or ≥ 3:1 for text ≥ 18.66 px bold or 24 px. The token tests in `packages/tokens/test/contrast.test.ts` compute the ratio for the allowed pairs listed in this document, and CI fails on a regression. Add a pair to that test before using it.

## 5. Compliance checklist (every UI PR)

- [ ] Only semantic tokens or Tailwind theme classes are used. No hex, rgb, px font sizes or arbitrary `[]` values except layout widths defined here.
- [ ] Every string is in both `en` and `sv`.
- [ ] Hover, focus-visible, active, disabled and loading states exist and are shown in `/_dev/ui`.
- [ ] Keyboard path verified, and the drag alternative exists.
- [ ] Touch targets ≥ 44 px on mobile.
- [ ] Reduced motion respected.
- [ ] axe check passes (Playwright `@axe-core/playwright`) for the touched screens.
- [ ] Screenshots attached for desktop (1440) and mobile (390).
