# ADR 0053: The in-app guide and Admin → System

- Status: accepted
- Date: 2026-10-10
- Implements: ADR 0052 §2, §6, §7 (WPs 11.5, 11.6)

## Decisions
1. **The guide is built at build time.**
   - A Vite plugin (`features/help/guide-build.ts`, also registered in `vitest.config.ts`) serves `virtual:rooster-guide/<locale>`. `marked` turns `docs/guide/**` and `pages.json` into HTML when the app is built, as one lazy chunk per locale (about 26 KB gzip each).
   - The chunks are precached with the app's JS, so the text works offline without the guide having been opened.
   - The content is trusted repo content. Even so, the build fails on `<script>`, `on*=` attributes, `javascript:` URLs and remote images.
2. **Links and anchors:**
   - `./page.md#anchor` becomes the in-app route `/help/page#anchor`. A repo file outside the guide links to GitHub. External links get `rel="noopener noreferrer"`.
   - Heading ids follow GitHub's slugs (Swedish letters kept, punctuation dropped, `-1` for repeats), so the same Markdown works on GitHub and in the app.
   - The build warns about an anchor with no matching heading, and a unit test expects no warnings for the real guide.
3. **Images:**
   - Screenshots are emitted content-hashed to `assets/guide/`, with their dimensions from the PNG header.
   - They are excluded from precaching. The service worker caches them cache-first when viewed (`rooster-guide-images`: at most 120 entries, 180 days), which keeps the PWA install small.
4. **Entry points:** the shortcut `G H` (also a palette command), "Open the guide" in the `?` cheat sheet, a "Help" item in the user menu, and Help in Settings.
5. **The keyboard page is generated.**
   - `pnpm docs:keyboard` runs `scripts/docs/keyboard.mjs` under plain Node 24, using type stripping (`features/help/keyboard-doc.ts` imports with `.ts` extensions; the key labels moved to the React-free `ui/kbd-labels.ts`).
   - The page follows the cheat sheet's grouping, which moved into `keymap.ts` (`shortcutSections`, `keyedShortcutsBySection()`), and gives Mac and Windows/Linux columns.
   - `--check` exits non-zero when the page is stale; CI runs it.
6. **Admin → System** is the first section of the admin page. It shows every `AdminSystem` field. A "Rebuild search index" action calls `POST /admin/search/reindex` after an inline confirmation.
7. **Storage:**
   - Settings → Data shows `Me.storage` as a React Aria ProgressBar. It is a ProgressBar rather than a Meter, because axe rejects the Meter's double role.
   - An upload refused with `storage_quota_exceeded` gets its own message, naming the quota and what is used.
