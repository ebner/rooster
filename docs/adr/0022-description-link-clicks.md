# ADR 0022: Ctrl/⌘+click opens description links

- Status: accepted
- Date: 2026-10-09
- Amends: 02 §9 (Description); FR-DET-3
- Code: `apps/web/src/features/editor/extensions.ts` (`LinkModClick`), `editor.css`

## Context
The description editor is always editable, and the Link mark had `openOnClick: false`. Links inherited the editor's `cursor-text`, and a click only placed the caret. The only way to follow a link was the bubble toolbar's "Open link" button, which users did not find.

## Decisions
1. **Ctrl+click (⌘+click on a Mac) opens a link in a new tab** (`noopener,noreferrer`), after the same `isAllowedLinkHref` check as the toolbar. A plain click still places the caret, so a link's text stays editable with the pointer. This follows Google Docs and VS Code; it was chosen over "a plain click opens" (Notion, Linear).
2. **Cursor:** while the modifier is held, the editor's host gets `data-link-mod` and links show the pointer cursor.
3. **Discoverability:** every link carries a "Ctrl+click to open" / "⌘+click to open" tooltip (an inline decoration, so the document and its Markdown are unchanged). A link's own Markdown title comes first.
4. **Keyboard path:** unchanged. Mod+K inside a link opens the link field with its "Open link" button.
5. Read-only descriptions are untouched: their links are plain anchors that open on a click.
