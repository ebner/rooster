# ADR 0070: The project site on GitHub Pages

- Status: accepted
- Date: 2026-11-13
- Amends: 03 §2.10 (brand placements: the site's header draws the logo in); AGENTS.md "No Actions artifacts" (the Pages artifact is the exception)
- Code: `apps/site/` (`scripts/build.ts`, `src/landing.ts`, `src/guide.ts`, `src/demo/model.ts`), `.github/workflows/pages.yml`

## Context
The README carried everything: the pitch, a feature list, a screenshot table, a phone strip, a five-step quick start, the CLI, the docs index and the licence. It was long for a repository front page and still a poor product page. The user guide (`docs/guide/`) was readable only as Markdown on GitHub or inside a running instance at `/help`.

## Decisions
1. **A static site in `apps/site`, published to GitHub Pages** at `https://ebner.github.io/rooster/`: a landing page and the user guide, in English (`/`) and Swedish (`/sv/`). The address is one variable, `SITE_URL` (its path is the base of every link); a custom domain later is the repository variables `SITE_URL` and `SITE_CNAME`.
2. **No framework.** Pages are rendered at build time from typed template functions (`src/html.ts`: an escaping `html` tag). The only browser JavaScript is the copy buttons and the parser demo. Vite bundles the stylesheet and the script (no new dependency); sharp converts the screenshots to responsive WebP and crops the feature shots to the part that matters, so their text stays readable.
3. **The guide is rendered by the app's own renderer** (`renderGuideMarkdown`/`buildGuide` in `apps/web/src/features/help/guide-build.ts`), so `/help` and the site show the same HTML; `rebaseGuideHtml` moves its `/help/<slug>` links and `/assets/guide/` images under the site's base and language. The build fails on a renderer warning (broken guide link, missing image, missing anchor) and on any internal link or image that doesn't resolve to a built file.
4. **The parser demo runs core's real parser** (`findDateInTitle`, `findTagTokens`, `findReminderTokens`, `formatRelative`, `dueState`, `describeRule`) in the browser, lazily (about 13 KB gzip), with the same rules as a title in the app: reminder tokens only count with a date, and a title made only of tokens keeps its text. The highlighted example is rendered at build time; the parsed result needs the visitor's today and appears once the script runs. Recurrence descriptions are the site's own short strings (the app's live in the `dates` i18n namespace, which the site doesn't load).
5. **Copy lives in `src/copy/{en,sv}.ts`**, typed so a missing Swedish string fails `tsc`. It doesn't go into `packages/i18n`: those catalogs ship with the app, and the site's text would only add weight there.
6. **Coop, light only.** Colours, type steps, spacing, radii, shadows and motion come from `@rooster/tokens`. The site adds only what the app never needs: display sizes for the headlines, page widths and a phone frame. The header logo draws itself in on the two start pages, the same sequence as the sign-in screen (03 §2.10 named only the app's signed-out screens).
7. **Deployed per release.** `pages.yml` builds the site from a pushed `vX.Y.Z` tag, so the site and the guide describe the released version and the quick start downloads that tag's `compose.yaml`. Running the workflow by hand redeploys the newest release tag, or a named ref (needed once: tags before 1.11 have no `apps/site`). The deployment uses `upload-pages-artifact` + `deploy-pages`: Pages only deploys from an Actions artifact, so this is the one exception to "no Actions artifacts", about 6 MB kept for a day. CI builds the site in the `build` stage (`pnpm build`) and tests the demo model and the link rebasing in `unit`.
8. **The README shrinks** to the pitch, links to the site and the guides, one screenshot, six bullets, a short quick start, development and the licence (with the Bun §7 permission unchanged).

## Not done
- No search on the site's guide; the app's guide search (ADR 0058) stays in the app.
- No dark theme, like the app (D-22). The screenshots are light.
- The operator guide and the sign-in setup stay Markdown on GitHub (English only).
- No analytics or third-party requests: fonts and images are served from the site itself.

## Review
- Codex (structured and focused, 2026-11-13): no injection, credential or deployment-permission issue. Fixed: the demo now follows the app's `parseTitle` step for step (escape backticks, a lone date phrase keeping its tags; a differential run of 8,404 inputs found no mismatch); the link check resolves every URL against its page (relative and absolute same-site links were skipped) and requires a file, not a directory.
- Accepted: the link check reads only double-quoted, lower-case attributes, decodes only `&amp;`, and splits `srcset` on every comma. It checks HTML that the site's own templates and the guide renderer write, which never use the other forms; supporting them would mean an HTML parser for a build check.
