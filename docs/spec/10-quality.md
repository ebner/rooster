# 10: Quality, Testing & Definition of Done

## 1. Definition of Done (every PR)

1. **Spec traceability.** The PR description lists the FR, AC and D IDs it implements, and any spec deviations, with justification. A deviation that changes behaviour requires a spec PR first, or in the same PR.
2. **Tests.** New logic has unit tests. New routes have API tests, including authorisation matrix rows. UX flows have Playwright coverage when they touch an AC.
3. **Green gates:** `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm e2e` (affected suites), `pnpm gen:api --check`, and `pnpm i18n:check` (key parity en/sv, no unused keys).
4. **UI PRs:** the design compliance checklist (03 §5), axe clean, and screenshots at 1440 and 390 px.
5. **Migrations:** generated (not hand-written unless it is FTS or a trigger), reversible in principle via the restore notes, and listed in the CHANGELOG.
6. **No new dependency** without a one-line justification in the PR. No dependency may duplicate an existing one's purpose.
7. **Docs:** user-visible behaviour changes update the relevant spec doc or the user guide.
8. **AGENTS.md is current:** structure, commands, conventions and phase status match the repository after the PR (see "Keeping this file current" in `AGENTS.md`).

## 2. Test pyramid

| Layer | Tool | Scope | Target |
|---|---|---|---|
| Unit (pure) | Vitest | `packages/core`: NL parser (table-driven, ≥ 150 cases EN+SV), formatters, dueState, recurrence, ordering helpers, reducers, view selectors | ≥ 95 % line coverage for `packages/core` |
| Service | Vitest + in-memory SQLite | Each service method: invariants (05 §4), LWW, reconcile, idempotency, rebalance | every invariant has a named test |
| API | Vitest + `app.request()` | Every route: happy path, validation, authz matrix, problem+json shape, OpenAPI contract | 100 % of routes |
| Component | Vitest + Testing Library (jsdom) | TaskRow states, keymap dispatch, DatePopover logic, outbox state machine | critical components |
| E2E | Playwright (Chromium, WebKit, mobile WebKit iPhone 15 and Pixel 8 profiles) | AC flows, offline, multi-user (two contexts), DnD, swipe | every AC tagged `@ac` |
| Visual | Playwright screenshots (`toHaveScreenshot`) | Kitchen sink, list states, date colours, pane, mobile frame | Chromium only, 0.1 % threshold |
| A11y | `@axe-core/playwright` | Every screen in e2e | 0 serious or critical violations |
| CLI | Vitest (spawn the built CLI against a test server) | Commands, JSON output, exit codes | every command |

## 3. Specific test suites

### 3.1 NL date corpus
`packages/core/test/dates.corpus.ts` holds rows of `[locale, input, now (ISO + tz), weekStart, expected {date, time?, recurrence?, remainingTitle}]`. It covers every row in 02 §8.2, plus:
- negative cases: "Review PR 142", "1/2 cup", "tom" with the sv locale, and "Mon Repos hotel booking", which does not parse (the position rule in 02 §8.1);
- year rollover (Dec 30 + "jan 3");
- DST boundaries (last Sunday of March and of October, Europe/Stockholm);
- week start Sunday vs Monday for "next week".

### 3.2 Ordering & concurrency
- Fuzz test: 1,000 random move, insert and delete operations, across 3 simulated clients with interleaved and out-of-order delivery. Invariants afterwards: no duplicate `(group, position)`, a deterministic total order, and every placement satisfies 05 §4.1.
- Rebalance is triggered by forcing long keys. The order is preserved.

### 3.3 Authorisation matrix
A table-driven test in `apps/server/test/authz.matrix.test.ts` declares, for every route, the expected status for each actor:
- anonymous
- non-member
- member
- owner
- other member, for user-owned resources (groups and placements)
- read-only PAT
- disabled user

Adding a route without a matrix row fails the test, because the test enumerates the OpenAPI routes.

### 3.4 Offline/sync e2e
Uses Playwright `context.setOffline`, two browser contexts plus API calls as a third actor. It covers AC-4.2 to AC-4.4, outbox persistence across a page reload while offline, and multi-tab leader election (two tabs, only one flusher, verified by the request count).

### 3.5 Markdown round-trip
A corpus of 40 Markdown samples (`apps/web/src/features/editor/markdown.corpus.ts`). For each, `md → Tiptap doc → md` must be identical, or equal after the documented normalisations, and the canonical form must survive a second round trip unchanged. Normalisations: N1 list bullets become `-`; N2 emphasis becomes `*` / `**`; N3 code blocks are fenced with ```` ``` ````; N4 ordered lists are renumbered; N5 a hard break is two trailing spaces, and other trailing whitespace is dropped; N6 `<url>` autolinks become bare URLs; N7 thematic breaks become `---`; N8 leading and trailing blank lines are dropped.

### 3.6 Ops tests
- The Docker image smoke test (CI): it boots with a minimal env, checks `/readyz`, logs in with the mock OIDC issuer, creates a task, restarts the container, and the task persists.
- The backup and restore drill: create data → `POST /admin/backups` → stop → restore the snapshot → start → verify the data.
- Migration test: apply all migrations to the snapshot of the previous release's fixture DB.

## 4. Performance budgets

| Metric | Budget |
|---|---|
| Initial JS (gzip) for `/o/:slug/my` | ≤ 500 KB, including the active locale's catalog; `pnpm bundle:check` enforces it in CI (ADR 0016 raised it from 250 KB, which the 04 §2 stack cannot reach, to 450 KB; ADR 0052 §10 to 500 KB). Tiptap, the palette, the list popovers (date, tags, move, group delete), the better-auth client, settings, import and admin are lazy-loaded. |
| Cold load LCP (desktop, cached SW, local server) | ≤ 1.0 s |
| Warm start of the installed PWA to an interactive list (cached data) | ≤ 800 ms on an iPhone 13-class device |
| Keypress → paint for create, complete and move with 500 tasks | ≤ 50 ms (p95) |
| Drag frame rate with 500 tasks | ≥ 55 fps |
| `GET /my-list` with 1,000 tasks | ≤ 50 ms server time |
| Mutation API p95 | ≤ 20 ms server time |
| Memory (server, idle, 5 users) | ≤ 150 MB RSS |

## 5. Accessibility
- WCAG 2.2 AA (see 02 §15 and 03).
- Manual passes per release: keyboard only, VoiceOver on macOS and iOS, NVDA with Firefox.
- Screen reader expectations for the list: the treegrid announces "Today, group, 3 tasks, expanded". A task reads "Book dentist, due tomorrow, not completed, 2 of 5 subtasks".

## 6. Security checks
- CI: `pnpm audit --prod` (high or critical fails), Biome security rules, and a secret scan (gitleaks).
- Tests: CSRF origin rejection, cookie flags, CSP header present, problem+json never contains stacks, uploads with a spoofed mime rejected, iCal token brute-force rate limit, PAT scope enforcement, and allowlist bypass attempts (an unverified email claim).

## 7. CI pipeline (reference)

```
install (pnpm, cached) → lint → typecheck → unit+service+api (parallel) → build (web, server, cli)
  → e2e (chromium, webkit, mobile-webkit; sharded) → visual → docker build (+ smoke) → [tag] publish image & CLI binaries
```

## 8. Observability of quality
- Every e2e failure keeps its trace and any visual diff in Playwright's output directory (ADR 0060: the suite runs locally).
- `CHANGELOG.md` follows Keep a Changelog. Conventional Commits are used for PR titles.
