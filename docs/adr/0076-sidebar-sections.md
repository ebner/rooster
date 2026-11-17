# ADR 0076: Sidebar section headers, indent guide and collapse defaults

- Status: accepted
- Date: 2026-11-18
- Amends: 02 §2 (sidebar), 03 §3.10 (the org header line)
- Code: `features/shell/sidebar-section-header.tsx`, `sidebar-sections.ts`, `sidebar-org-section.tsx`, `sidebar-all-section.tsx`

## Context
With several organisations the sidebar read as one long list (maintainer, 2026-11-18): the org header (xs, muted, a small avatar) was weaker than the items under it, every section repeated the same icons and labels, sections were parted only by a 16 px gap, and the collapse chevron showed only on hover. `org_member_pref.collapsed` is a plain boolean, so it cannot tell "never touched" from "expanded".

Common practice (Linear, Slack, Notion; macOS Finder and Mail): a container is a collapsible tree node with a visible chevron and its own icon, its items indented beneath it; more space above a section header than below it (proximity); a hairline between sections; one small identity colour per container rather than styling each row.

## Decision
1. **Header:** every section header, for each org and for All organisations, is a 32 px row (the item height, `h-control`): a 16 px chevron at the start in `icon-subtle`, always visible and rotated −90° when collapsed; a 24 px avatar (`AllOrgsMark` for All organisations); the name in `text-sm` 600 `text-text`; the grip and "⋯" on hover. The whole toggle is one button (Enter/Space, `aria-expanded`).
2. **Rhythm:** sections are parted by a 1 px `border-border` hairline with 12 px on each side (about 24 px above a header, 4 px below it). A lifted section hides its own hairline while dragged.
3. **Indent and guide:** a section's items sit 12 px in, past a 1 px guide in the org's tag colour (`fg` at 40 %), or `border-border` for an org without a colour, so item icons sit under the avatar. The icon rail keeps every item and gains only the hairlines.
4. **Collapse defaults:** a section is collapsed when the user collapsed it in this browser (an explicit expand there wins over everything); else when the server pref says `collapsed: true` (counts as explicit); else when it is untouched, the user has three or more orgs, and it is not the org in the URL. Otherwise it is open. The browser keeps a per-user open / closed / unset choice in localStorage (`userStorageKey`, swept on sign-out); explicit toggles still write `PATCH /me/orgs/:id {collapsed}`. Navigating into a collapsed org doesn't expand it; an untouched org shows open while it is the one in the URL. All organisations is open by default and collapsible in the browser only.

## Consequences
- The choices are per browser: an expand on one device doesn't undo a collapse made on another; a collapse made elsewhere still applies where nothing was chosen.
- The sidebar's layout changes when moving between untouched orgs.
- Tests that click a non-active org's items with three or more orgs expand it first (`e2e/support/sidebar.ts`, `expandSection`).

## Considered
- A tri-state server pref: a migration and API change for what is a per-device preference.
- Expanding on every navigation: overrides explicit choices.
- Uppercase section labels or tinted section backgrounds: too loud, or not distinct enough.
- Hiding each org's Today, Next 7 days and Overdue now that All organisations covers them: a product change, left out for now.
