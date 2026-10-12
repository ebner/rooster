# ADR 0052: Phase 11 decisions

- Status: accepted
- Date: 2026-10-10
- Amends: 09 (Phase 11), 10 §6, 08 §9

These were settled before Phase 11 started.

## 1. Version
Phase 11 changes no API contract, so it is released as **1.5.0** (strict SemVer); v2.0 waits for a real breaking change. Phase 10 was released first, as 1.4.0.

## 2. Documentation
- **The Markdown in the repo is the single source.**
  - The user guide is in `docs/guide/en/` and `docs/guide/sv/`, one file per page. `docs/guide/pages.json` lists the pages in order, with a slug and a per-locale title.
  - The operator guide (`docs/operator.md`) and `CONTRIBUTING.md` live only in the repo.
  - The README is the front page: a hero screenshot, the features, a short gallery and the quick start.
- **The app renders the user guide at `/help` and `/help/<slug>`.**
  - The Markdown becomes HTML **at build time**, from trusted repo content. So there is no runtime Markdown dependency, and no user content is involved.
  - The pages are a lazy chunk, so the guide's text works offline once the app is installed.
  - Screenshots in the app are served from the build and cached at runtime when viewed. They are not precached, which keeps the PWA install small.
  - The guide is linked from the `?` cheat sheet, the user menu and Settings.
- **The keyboard page is generated** from the keymap registry (`pnpm docs:keyboard`). CI fails when it is out of date, so shortcut docs are never written by hand (hard rule 8).

## 3. Screenshots
- **Light only.** The app has no dark theme (D-22, which stays for 1.5.0; a dark theme is in the backlog). The pipeline's dark projects skip themselves until one exists.
- `pnpm docs:screenshots` starts the e2e stack (mock IdP, a fresh server) and seeds a fictional demo team through the public API. The team has several members and orgs, and its data covers groups, tags, subtasks, recurring tasks, reminders, comments, mentions and attachments. Then the script captures the key screens with Playwright, on desktop (1440 px) and phone (iPhone 15), in English.
- The images are committed in `docs/screenshots/` and used by the guide and the README. They are regenerated deliberately, not in every CI run.
- The demo data is synthetic. No real people, companies or addresses appear.

## 4. Accessibility
- The e2e suite runs the automated checks (in the release run since ADR 0060, not in CI): axe on every screen in both themes and both form factors, a keyboard-only journey, and the list's accessible names.
- The manual screen reader passes in 10 §5 (VoiceOver on iOS and macOS, NVDA with Firefox) follow `docs/accessibility-checklist.md`. The maintainer runs them per release, and the findings come back as issues.

## 5. Security checks in CI
- `pnpm audit --prod --audit-level high`: a high or critical advisory fails the build. One moderate advisory remains (esbuild through better-auth's drizzle-kit, a dev-server issue that doesn't apply in production).
- The secret scan is gitleaks v8.28.0 over the git history (`scripts/secret-scan.sh`, using the binary or its container). The 14 findings in history are test-only secrets, sample push keys and OpenAPI examples. They are pinned by fingerprint in `.gitleaksignore`, so any new secret still fails.

## 6. Per-user attachment storage quota
- `ROOSTER_USER_STORAGE_MB` defaults to **1024**; `0` means no quota. It counts the bytes of every attachment the user uploaded that still exists, including those on tasks in Trash until they are purged. Thumbnails and avatars don't count.
- An upload that would go past the quota gets `413 storage_quota_exceeded`, with `limitBytes` and `usedBytes` in the problem. Nothing is stored.
- `GET /me` carries `storage: { usedBytes, quotaBytes }` (`quotaBytes` is null without a quota). Settings → Data shows it.

## 7. Admin → System
`GET /admin/system` (instance admins only) returns the `AdminSystem` DTO:
- the version and git SHA, and the uptime;
- the database and WAL sizes;
- the last backup;
- the last run of each job;
- whether SMTP is configured, the push key status and the number of push subscriptions;
- the number of SSE connections;
- the attachment storage (backend, total bytes and file count);
- counts of users, orgs and tasks.

Admin → System shows all of it, next to the existing sections.

## 8. Performance
- The pass seeds one org with 2,000 tasks. The 10 §4 budgets apply unchanged.
- Keypress → paint in My tasks with 2,000 open tasks is held to the AC-2.12 budget (p95 ≤ 50 ms). If that needs list virtualisation or a similar change, the change is recorded in an ADR, and keyboard and screen reader behaviour stay intact.

## 9. Spec gaps found while writing the guide
The documentation pass compared the spec with the code. Decided:
- **Build in Phase 11 (WP 11.7):** the list header's "⋯" menu (02 §2) and Settings → Behaviour's switches for dates in titles and the completion hide delay (FR-SET-2).
- **Amend the spec to match the code:**
  - **No Prometheus `/metrics`.** `ROOSTER_METRICS_TOKEN` is removed from the config.
  - **The image is built for linux/amd64 only.**
- **Fixed as bugs:**
  - the admin push-keys copy, which contradicted ADR 0040;
  - the phone swipe reveal, drawn at the wrong offset;
  - phone rows squeezing the title;
  - raw Markdown in inbox excerpts.
- **Added:** a "Rebuild search index" action in Admin → System.

## 10. Bundle budget
The initial-bundle budget was raised (10 §4) from 450 KB to **500 KB** gzip. Phase 11 brought it to about 449 KB: Help entry points, the header ⋯ menu, accessible row names and new strings in the startup catalog. The lazy-loading rule is unchanged: UI that appears only on interaction still loads lazily (AGENTS.md).
