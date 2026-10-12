# ADR 0058: Searching the guide

- Status: accepted
- Date: 2026-10-12
- Builds on: ADR 0053 (the in-app guide)

## Context
The guide grew to fourteen pages, and the only way to find something was to guess its page. The header also repeated the open page's title, which the pinned page list beside the article already marks.

## Decisions
1. **Search runs in the browser, over the loaded guide.** `features/help/guide-search.ts` splits each page's build-time HTML at its `h2`/`h3` headings into sections (the text before the first heading is the page's own section) and keeps the plain text, built once per loaded guide. There is no server index and no new chunk, so it works offline like the guide, in the reader's language.
2. **Matching:**
   - A section matches when it contains every word of the query.
   - Case and accents are ignored ("aterkommande" finds "återkommande"). Folding keeps one character for one, so matches map back onto the original text for highlighting.
   - Ranking: the section's heading counts most (more at a word start), then the page title, then up to five occurrences in the text. Ties keep the guide's order.
   - Every match is listed; the guide has a few hundred sections.
3. **Results:** each one links to `/help/<page>#<heading>`, showing the page, the heading and a snippet of about two lines from the sentence of the first match, with the matches marked. The count is announced in a status line.
4. **Where:** a search field above the page list on desktop article pages, and above the page list on `/help` (the only place on phones, which have no list beside the article). While there is a query the results replace the article, which stays mounted and hidden, so closing the search doesn't rebuild or refocus it. ↓ moves from the field to the results, Enter opens the first one, Esc clears the field and keeps focus there.
5. **The query is in the URL** (`?q=`, replaced while typing rather than pushed), so Back from a result returns to the same results.
6. **The desktop header says "Help"**, not the page's title: the page list marks the open page. The article keeps the page title as its accessible name. Phones keep the page title in their header, with the way back to the page list.

## Consequences
- Synonyms are not handled: the text has to use the word people search for. The terminal app is now called a TUI in its heading for that reason.
- The palette (Ctrl+K, and Search on phones) does not search the guide yet; it could reuse `searchGuide` later.
