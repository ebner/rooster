# ADR 0062: A tap on a description link shows a link card on touch screens

- Status: accepted
- Date: 2026-10-16
- Amends: 02 §9 (Description); ADR 0022
- Code: `apps/web/src/features/editor/link-card.tsx`, `markdown-editor.tsx`

## Context
ADR 0022 made Ctrl/⌘+click open a description link and kept a plain click for editing the link's text. Phones and tablets have no modifier key and no hover tooltip, so a tap on a link only placed the caret (and raised the keyboard). The only way to follow a link was to select its text, tap the toolbar's link button, then "Open link", which nobody finds.

The options considered:
- a tap opens the link on touch screens (Notion, Linear): a link's text could no longer be edited with a tap, and a stray tap while editing leaves the page;
- phone descriptions read-only until "Edit" is tapped: changes editing on phones and costs a tap every time;
- long-press to open: undiscoverable, and a long press in editable text starts a selection on iOS.

## Decisions
1. **A tap with a finger or pen on a link shows a link card**, anchored under the whole link (Google Docs does the same). The tap still places the caret, so the text stays editable.
2. **The card shows the address** (without `https://`, `mailto:` or a trailing slash), which opens the link in a new tab, and **Edit** (selects the link and opens the toolbar's link field) and **Remove** (unlinks it, keeping the text). Addresses that `isAllowedLinkHref` refuses are shown as text and do not open.
3. **The card goes away** when the caret leaves the link, on any key or edit, on a mouse press, when the focus leaves the text, or when another device's edit replaces the description. Edit and Remove check that the link is still where it was, so a stale card never changes other text. Its buttons do not take the focus, so the keyboard stays up. The card follows its link when the pane scrolls, and hides while the link is scrolled out of view.
4. **Touch only, for now.** The card is tied to the pointer type of the tap (`pointerType` other than `mouse`), so a touch screen laptop gets it and a mouse never does. Desktop keeps ADR 0022 (Ctrl/⌘+click, and Mod+K inside a link). Showing the card whenever the caret enters a link, on every device, is a possible later step.
5. Read-only descriptions and comments are unchanged: their links open on a tap.

## Consequences
- Opening a link on a phone takes two taps, and the keyboard comes up with the first one, since the description is editable.
- Keyboard parity is unchanged: the card is a pointer shortcut for what Mod+K already offers.
