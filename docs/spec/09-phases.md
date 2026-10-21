# 09: Implementation Phases

## How to use this plan

- Phases are **sequential**. Work packages (WP) **within** a phase can run in parallel unless a dependency is noted.
- Each WP is sized for roughly one PR.
- A phase is complete when **all its acceptance criteria (AC) pass in CI** and the **exit demo** works on a fresh `docker compose up`.
- Every WP must satisfy the Definition of Done in [10-quality](10-quality.md) §1.
- AC are written to be automatable. Each AC maps to at least one test, named with the AC ID: `test('AC-2.7 …')`.

```
P0 Foundations ─► P1 Auth & orgs ─► P2 List core ─► P3 Detail pane & subtasks ─► P4 PWA/offline/realtime/mobile ─► P5 Views, search, palette ══► v1.0 (switch-over)
                                                                                                                                                  │
   P6 Collaboration ─► P7 Notification delivery ─► P8 CLI & PATs & public API ─► P9 TUI & MCP ─► P10 Recurrence, attachments, iCal ─► P11 Hardening ══► 1.5.0
```

P8 depends only on v1.0. It can start in parallel with P6 and P7 if capacity allows, because it is a separate app consuming a stable API.

---

## Phase 0: Foundations

**Goal:** an empty but production-shaped skeleton. Green CI, Docker image, design tokens, i18n, kitchen sink.

| WP | Content |
|---|---|
| 0.1 Monorepo | pnpm workspace with catalogs, `tsconfig.base.json` (strict), Biome config, root scripts (`dev`, `build`, `test`, `lint`, `typecheck`, `gen:api`, `e2e`), `.editorconfig`, `.nvmrc` (24), and `AGENTS.md` / `CLAUDE.md` / `README.md` per the spec. |
| 0.2 Server skeleton | `config.ts` (zod env, `_FILE` support, exit code 78), the `createApp(deps)` factory, pino with request IDs, problem+json error handler, `/healthz`, `/readyz`, `/api/v1/meta`, `/api/v1/openapi.json`, `/api/docs`, static serving of the web build with SPA fallback, `secureHeaders` with CSP, and graceful shutdown. |
| 0.3 DB | Drizzle setup, pragmas, migration runner at boot, the pre-migration backup function, the `instance_setting` table, the `PRAGMA optimize` job, and a test helper `createTestDb()` (in-memory, migrated). |
| 0.4 Web skeleton | Vite 8 + React 19 + TanStack Router + Query, Tailwind 4 wired to `packages/tokens`, Geist fonts, the i18n init (en/sv) with a language switch, and the `/_dev/ui` kitchen sink route (dev builds only). |
| 0.5 Coop components v0 | Button, IconButton, Input, Checkbox (task round), Chip, Kbd, Tooltip, Popover, Menu, Toast region, Avatar, Skeleton, Sync pill: every state rendered in the kitchen sink. Brand assets: logo, favicon and app icons (03 §2.10). |
| 0.6 packages/core | Zod schema module structure, the UUIDv7 helper, the `fractional-indexing` re-export plus helpers, and the date utilities scaffold (`today(tz)`, `formatRelative`, `dueState`) with tests. |
| 0.7 Docker & CI | Dockerfile (multi-stage, distroless nonroot), `compose.yaml`, healthcheck, and proxy snippets. CI workflow: install → lint → typecheck → unit → build → e2e smoke → docker build. Ships a GitHub Actions file plus generic `scripts/ci.sh` so it is CI-vendor neutral. |

**Acceptance criteria**
- AC-0.1 `pnpm i && pnpm build && pnpm test && pnpm lint && pnpm typecheck` succeed on a clean clone.
- AC-0.2 `docker compose up` with a minimal `.env` starts. `/readyz` returns 200 and `/api/docs` renders.
- AC-0.3 A missing `ROOSTER_BASE_URL` makes the process exit with code 78 and a readable error.
- AC-0.4 `/_dev/ui` shows every Coop v0 component in all states. The axe scan has 0 violations.
- AC-0.5 Switching the language to Svenska changes all kitchen-sink strings, with no missing keys (the CI i18n key-parity check passes).
- AC-0.6 The image runs as non-root, is under 250 MB uncompressed (rooster's own layers under 50 MB), and passes the healthcheck.

**Exit demo:** open the app and see a styled "Hello rooster" page in both languages.

---

## Phase 1: Auth, users, orgs

**Goal:** sign in with Google or OIDC, get a Personal org, create and join a business org, and see orgs in the sidebar.

| WP | Content |
|---|---|
| 1.1 better-auth | Instance config (04 §4.4), the Drizzle adapter tables plus additional fields, Google and genericOAuth from env, the session cookie, and the allowlist hook with a `/not-invited` page. |
| 1.2 Bootstrap | The personal org plus Inbox plus default groups on user creation (localised), and the `org_member_pref` row. |
| 1.3 Org service and API | Orgs CRUD, members, invites (email and link), accept flow, last-owner rule, personal-org restrictions, and org order. |
| 1.4 Web shell | Login page (provider buttons from `/meta`), app frame (sidebar with org sections, collapse to rail, user menu), routing `/o/:slug/my` (empty list placeholder), org create popover (inline: name, emoji), org settings page (members, invites), and the invite accept page. |
| 1.5 Settings | Profile (language, timezone, week start, date and time format), sessions list and revoke. |
| 1.6 Admin | Allowlist management and the users list with disable. |
| 1.7 Test IdP | A mock OIDC issuer for tests (`oauth2-mock-server`, or a tiny in-repo issuer) with a Playwright login fixture. |

**Acceptance criteria**
- AC-1.1 A user not on the allowlist is rejected at the OIDC callback and sees `/not-invited`. No user row is created.
- AC-1.2 The first login creates exactly one personal org with Inbox, Today, Prio and Upcoming (Swedish names when the browser language is sv-SE).
- AC-1.3 Owner A creates "Northwind" and invites B by link. B (not otherwise allowlisted) can sign in through the invite and becomes a member. A second use of a single-use link fails.
- AC-1.4 The personal org rejects invites (`409 personal_org`) and cannot be deleted.
- AC-1.5 The sidebar shows both orgs. Dragging B's org above Personal persists across reload.
- AC-1.6 The authorisation matrix tests pass for every P1 route (10 §3.3).
- AC-1.7 Revoking a session in Settings logs that browser out on its next request.

**Exit demo:** two browsers, two users, a shared org, each with their own sidebar order.

---

## Phase 2: The list core (the heart)

**Goal:** a fully keyboard-driven My tasks with groups, inline tasks, due dates, NL parsing, drag and drop, completion and undo, with no detail pane yet.

| WP | Content | Depends on |
|---|---|---|
| 2.1 Data and services | `task` and `placement` tables (`task_group` exists since P1); the per-user API rate limit (600/min, 06 §1); GroupService, TaskService (create, patch with LWW and field clocks, complete, delete and restore, bulk), PlacementService.reconcile, OrderingService (with rebalance), idempotency middleware, the `my-list` endpoint, the trash endpoints and the purge job. | — |
| 2.2 Date engine | `packages/core/dates`: the NL parser EN+SV (02 §8 full table as test cases), `formatRelative` EN/SV, `dueState`, and week-start-aware helpers. A property test checks that `parse(format(d)) == d` for explicit dates. | — |
| 2.3 List rendering | Flat row model selector, TaskRow, GroupHeader, AddRow, sticky headers, Inbox behaviour, empty states, skeletons, and "show completed". | 2.1 API types |
| 2.4 Editing model | The Navigate/Edit modes, the keymap registry plus cheat sheet, draft rows, Enter/Shift+Enter/Backspace rules (02 §3.4–3.5), paste multi-line, title token highlighting (dates and `>Group`; `#tag` and `@` come later), and the selection and multi-select bulk bar. | 2.3 |
| 2.5 Date popover | DateCell, DatePopover (NL input, chips, calendar, time), and commit and close rules. | 2.2, 2.3 |
| 2.6 DnD | `useListDnd()` on dnd-kit: tasks within and between groups, collapsed-group hover-expand, group reordering with temporary collapse, multi-drag, keyboard drag, the keyboard move shortcuts, auto-scroll, live-region announcements. | 2.3 |
| 2.7 Mutation pipeline v1 | Optimistic reducers in `packages/core/reducers`, the mutation wrapper with Idempotency-Key and edit time, the undo stack with inverse ops, and toasts. (The outbox persistence comes in P4, but the API shape is final here.) | 2.1 |
| 2.8 Group ops | Create at the cursor (Tab+N split), colon-to-group, rename, collapse, delete popover (move or delete), and restore. | 2.4 |
| 2.9 Backups (early safety net) | The nightly `VACUUM INTO` job with rotation, and the admin endpoints to list, create and download backups (06 §2.10). A minimal Admin → Backups page. Daily use starts in this phase, so data must be protected from day one. | 2.1 |

**Acceptance criteria**
- AC-2.1 Typing "Buy milk", Enter, "Call Bob fri", Enter, then Esc creates 2 tasks in order. The second is due on the next Friday and its title is "Call Bob". Reload preserves everything.
- AC-2.2 Shift+Enter inserts above. Ctrl+↑/↓ reorders. Ctrl+Shift+↓ moves the task to the start of the next group. The order is identical after reload and in a second browser.
- AC-2.3 Mouse drag of a task from Prio into a collapsed "Upcoming" (hovering expands it) lands at the indicated position. Keyboard drag (Space, arrows, Space) works, and both are announced in the live region.
- AC-2.4 Dragging a group header reorders groups. The Inbox cannot be moved and is hidden when empty.
- AC-2.5 Completing shows the pop animation, hides the task after 1.5 s, and offers an undo toast. Undo restores the same position. Ctrl+Z works too.
- AC-2.6 Backspace on a fresh empty row deletes only that row, even when held down. Backspace on an empty title of a task with a description does not delete it.
- AC-2.7 The date popover closes on a day click. "next week", "imorgon" (sv UI) and "12 okt" resolve correctly. The labels and colours match 03 §2.3 for each state (visual regression snapshot).
- AC-2.8 Tab+N on the 2nd of 4 tasks creates a new group containing tasks 3 and 4, with the caret in the name. A single undo reverts the split.
- AC-2.9 Deleting a non-empty group with "Move to Prio" appends its tasks to Prio in their order. "Delete tasks too" moves them to Trash, and restore brings back both the group and the tasks.
- AC-2.10 Two concurrent `move` requests between the same neighbours produce a deterministic total order, with no duplicate positions within a group.
- AC-2.11 Replaying an identical `Idempotency-Key` returns the same response with no duplicate effect.
- AC-2.12 Interaction latency: with 500 tasks, keypress to paint for create, complete and move is under 50 ms on a mid-range laptop (Playwright trace budget).

**Exit demo:** a user works in rooster for a day on desktop (no pane yet).

---

## Phase 3: Detail pane, subtasks, tags

| WP | Content |
|---|---|
| 3.1 Pane frame | The split layout (D-29), resize, full-screen, URL sync, the follow-selection behaviour, Space peek, and save state indicators. |
| 3.2 Properties | Due, start and time; group select; created-by info. |
| 3.3 Description | Tiptap with `@tiptap/markdown`, the bubble toolbar, Markdown shortcuts, collapse past 12 lines, and **Markdown round-trip tests** (a corpus of 40 samples). |
| 3.4 Subtasks | Data rules (depth limit, cycle check), inline expansion in the list (chevron, persisted), the subtask list in the pane with the same row and keyboard model, sibling reorder DnD, orphan-subtask rows with breadcrumb (reconcile rules from 05 §4.1), and the counters in parent rows. |
| 3.5 Tags | Tag service, `#tag` token in titles with autocomplete, the tag picker popover (Tab+T / T), chips in rows, Settings → Tags (rename, recolour, merge, delete), and the tag filter in the header. |
| 3.6 Duplicate | Ctrl+D, including subtasks. |

**Acceptance criteria**
- AC-3.1 Clicking a row body opens the pane and the URL becomes `/o/:slug/t/:id`. ↑/↓ in the list switches the pane content. Esc returns focus to the list, and Esc again closes the pane.
- AC-3.2 A description containing a heading, nested list, checklist, code block and link survives save, reload and edit with identical Markdown.
- AC-3.3 Expanding a parent shows its subtasks indented. Enter in a subtask creates a sibling subtask. Completing a subtask updates the parent's "2/5" counter immediately.
- AC-3.4 Typing `#urgent` creates the tag "urgent" on first use, shows a chip, and filtering by it shows only the matching tasks.
- AC-3.5 Setting `parent_id` to a descendant gets `422`. A depth over 5 gets `422`.

---

## Phase 4: PWA, offline, realtime, mobile

| WP | Content |
|---|---|
| 4.1 Persistence | `persistQueryClient` to IndexedDB, `storage.persist()`, and cold-start rendering from the cache. |
| 4.2 Outbox | The IndexedDB outbox, the flusher with Web Locks leader election, BroadcastChannel, backoff, the error classification of 04 §6.2, the sync pill, and the "couldn't apply" toast. |
| 4.3 SSE | The server hub with per-user targeting, heartbeat, `hello` version; the client EventSource with reconnect, invalidation and origin-skip. |
| 4.4 Service worker | injectManifest `sw.ts`, precache, navigation fallback, the update prompt with the outbox guard, manifest and icons, and the install prompts (Android toast, iOS tip sheet). |
| 4.5 Mobile layout | Breakpoints, header org switcher sheet, view segmented control, bottom nav (My tasks · Search · Settings; the Inbox tab comes in P6), FAB, the accessory bar above the keyboard (`visualViewport`), 52 px rows, full-screen detail sheet with history integration, safe areas, and pull to refresh. |
| 4.6 Gestures | Swipe right/left with configurable actions, long-press drag (350 ms, haptics), the long-press selection mode with the bulk bar, and the quick date sheet. |
| 4.7 Tablet | The icon-rail sidebar and the overlay pane. |

**Acceptance criteria**
- AC-4.1 Load the app, go offline (Playwright `setOffline`), then reload: the app shell and My tasks for every org render from the cache.
- AC-4.2 Offline: create 3 tasks, complete 1 and move 1 → the pill reads "Offline · 5 pending". Back online, the changes sync in order, a second device shows the result within 2 s, and there are no duplicates even if the connection drops mid-flush.
- AC-4.3 LWW: device A (offline) renames a task at t1. Device B (online) renames it at t2 > t1. When A comes online, B's title remains and A's client converges to it after its sync.
- AC-4.4 An op targeting a task deleted elsewhere is dropped with a toast, and the client state is corrected.
- AC-4.5 On an iPhone 15 profile (WebKit), swipe right completes, swipe left opens the date sheet, long-press drag reorders, and the FAB creates a task with the accessory bar visible above the keyboard. Inputs are ≥ 16 px (no zoom).
- AC-4.6 The Lighthouse PWA installability checks pass. Manifest icons, including maskable ones, are valid.
- AC-4.7 After a deploy, an open client shows "New version available". Reload is deferred while the outbox is non-empty.

---

## Phase 5: Smart views, search, palette, export → **v1.0**

| WP | Content |
|---|---|
| 5.1 Smart views | Selectors in `packages/core/views.ts` (shared with the server `?view=`), the sidebar counts, the Today / Next 7 days / Overdue / No date screens, and inline add with date inheritance and the `>Group` token. |
| 5.2 Search | FTS5 table and service maintenance, the reindex command, and `/search`. |
| 5.3 Command palette | The Ctrl+K panel, actions from the keymap registry, recent tasks, prefixes, and offline client-side filtering. |
| 5.4 Export and Trash UI | JSON and Markdown export; the Trash list with restore and permanent delete. |
| 5.5 Release | `CHANGELOG`, the 1.0.0 image, the README quick start, and the OIDC setup docs. |

**Acceptance criteria**
- AC-5.1 Today shows overdue and today tasks from all groups, each with a group chip. Creating a task there sets due = today and places it in the Inbox. Completing one there removes it from My tasks too.
- AC-5.2 Searching "tand" finds "Boka tandläkare" (prefix match). "rapport" matches a description. Results never include tasks from orgs the user is not a member of (test).
- AC-5.3 Ctrl+K → ">dark" shows no results gracefully. ">move" lists the move action for the selected task.

**v1.0 exit demo, the switch-over:** move the open tasks over from the previous tool by hand (paste a multi-line list per group), then use rooster on desktop and the installed iPhone PWA for a week. The previous tool is no longer needed for daily use.

An import from other task managers is on the [Backlog](#backlog); v1.0 ships without it (D-18).

---

## Phase 6: Collaboration

| WP | Content |
|---|---|
| 6.1 Assignment | The assignee field (Tab+A / A, `@name` token), reassignment → the other person's Inbox (placement reconcile), unassigned tasks, and the avatar in rows where relevant. |
| 6.2 Everyone's tasks | The view, filters, inline add per member, and drag between members to reassign. |
| 6.3 Comments and activity | Comment service, mentions (`@[Name](user:id)` storage, an autocomplete in the composer), the activity writer hooked into services, grouped rendering, and the sticky composer. |
| 6.4 Followers | Auto-follow rules, follow/unfollow, the avatar stack. |
| 6.5 In-app notifications | Fan-out from domain events, the `/inbox` view (plus the mobile bottom-nav Inbox tab), the bell badge via SSE, mark read and unread, and the preference matrix (in-app column). |
| 6.6 Collaboration hidden in the personal org | FR-COL-6. |

**Acceptance criteria**
- AC-6.1 A assigns a task to B. It appears at the top of B's Inbox (live via SSE) and disappears from A's groups. B gets a notification, and A gets none (actor exclusion).
- AC-6.2 A subtask of A's task assigned to B appears in B's list as a row with the breadcrumb "Parent ›". When the parent is later assigned to B, the separate row disappears and the subtask shows under the parent.
- AC-6.3 Mentioning @B in a comment notifies B and makes B a follower.
- AC-6.4 Removing B from the org unassigns B's tasks. They show under "Unassigned" in Everyone's tasks, and B's groups for that org are gone.

---

## Phase 7: Notification delivery

| WP | Content |
|---|---|
| 7.1 Web Push | VAPID bootstrap, subscription management UI (per device, a test button), SW `push` and `notificationclick`, removal of expired subscriptions on 404/410, and the iOS hint ("install first"). |
| 7.2 Email | nodemailer transport, react-email templates (EN/SV, Coop tokens, plain-text alternative), invite emails (P1 invites gain email delivery), immediate and batched notifications, the daily digest, and unsubscribe links (signed tokens). |
| 7.3 Scheduler | Due reminders and digest jobs keyed by user-local time, with `job_run` idempotency. |
| 7.4 Preferences | The full matrix UI (event × channel), reminder and digest times. |

**Acceptance criteria**
- AC-7.1 With push enabled and the due reminder set to 08:00 Europe/Stockholm, a user with 3 tasks due today gets exactly one push at 08:00 local time, even across a container restart at 07:59:30.
- AC-7.2 The digest email renders correctly in EN and SV (snapshot), and its unsubscribe link disables only the digest.
- AC-7.3 Without SMTP configured, email options are hidden and invites fall back to copyable links.

---

## Phase 8: CLI, PATs, public API polish

| WP | Content |
|---|---|
| 8.1 API polish | OpenAPI descriptions and examples for every route, the `/api/docs` landing, the `api-client` package build, and contract tests for every route. |
| 8.2 Grants, PATs and devices | The **grant model** (11 §2): `access_grant`, capabilities and org/group constraints enforced in services (`authorizeGrant`), `forbidden_scope`/`outside_grant`. The api-key plugin integration (PATs backed by grants). The device approval page `/device` as the consent screen (11 §3.1). Settings → Connected apps (list, edit constraints, revoke, new token shown once; 11 §3.2). Authz-matrix grant columns. |
| 8.3 CLI core | Config and profiles, keychain, login (device flow) and `--with-token`, ref resolution, every command in 07 §4 except tui and mcp, human and JSON output, exit codes, and completions. |
| 8.4 Distribution | Bun-compiled binaries in CI for 5 targets, and the README section. |

**Acceptance criteria**
- AC-8.1 `rooster login` on a headless machine completes the device flow approved from a phone, and `rooster whoami` prints the user.
- AC-8.2 `rooster add "Pay invoice tom #finance >Prio"` creates a task in Prio with tomorrow's due date and the finance tag. `rooster ls --json | jq` returns it.
- AC-8.3 A read-only PAT can run `ls` and `show`, but `add` exits with code 3 and a clear message.
- AC-8.5 A PAT limited to writing in the group *Prio* of org A can add and complete tasks in *Prio*. Moving a task out of *Prio*, or adding to *Today*, gets `403 outside_grant` (CLI exit 3, naming the allowed groups). Tasks of org B are invisible to it (`404`). Narrowing the grant in Settings → Connected apps applies to the very next request.
- AC-8.4 Every API response in the e2e suite validates against the OpenAPI schema.

---

## Phase 9: TUI, MCP & agent access

| WP | Content |
|---|---|
| 9.1 TUI | 07 §5. |
| 9.2 MCP tools | `packages/mcp`: the tools of 07 §6 with their capability map, `instructions`, the `rooster://{org}/my` resource, and the stdio server `rooster mcp` plus `rooster mcp setup` (11 §5.1). |
| 9.3 OAuth 2.1 authorization server | better-auth OAuth 2.1 Provider plus CIMD with the ADR 0041 adapters (issuer `<base>/api/auth`, the grant in `referenceId`), rooster's consent screen (incl. the "Allow deleting tasks" checkbox and "This session only") and grants, opaque audience-bound tokens, refresh rotation, the CIMD SSRF guard, optional DCR, AS and resource metadata (11 §4). |
| 9.4 Remote MCP | `/mcp` Streamable HTTP (protocol 2026-07-28), 401/403 challenges with `resource_metadata` and step-up scopes, per-grant rate limits (11 §5.2). |
| 9.5 Discovery & skill | The MCP Server Card (SEP-2127), the AI Catalog, the agent-skills index, `llms.txt`, `ROOSTER_AGENT_DISCOVERY`; the rooster `SKILL.md`, and `rooster skill print\|install` (11 §6). |
| 9.6 Security settings and admin capability | Settings → Security lists linked sign-in identities and unlinks one (never the last; FR-SET-3). The `admin` capability for PATs and CLI logins of instance admins, never OAuth or MCP, and `rooster admin reindex` (ADR 0041). |

**Acceptance criteria**
- AC-9.1 The TUI lists, creates, completes, dates, moves, and switches views and orgs. A change made in the web appears in the TUI within 2 s.
- AC-9.2 An MCP inspector session can call `list_tasks`, `create_task` (NL due date) and `complete_task`. `--read-only` hides the mutating tools. Activity entries show `via: mcp`.
- AC-9.3 An MCP client that implements the 2026-07-28 authorization spec, given only `https://<host>/mcp`, discovers the authorization server (RFC 9728 → RFC 8414). It registers through a Client ID Metadata Document and completes PKCE with `resource` and `iss` validation. The user then grants `tasks:read` on one org through the consent screen, and the client lists that org's tasks. A token for `/mcp` is rejected by `/api/v1`, and vice versa.
- AC-9.4 Calling `create_task` with a read-only token yields `403 insufficient_scope` with `scope="tasks:write"`. After step-up, the user allows writing only in *Inbox*: creating there succeeds, and moving the task to *Prio* returns a tool error naming the allowed groups. Revoking the app in Settings → Connected apps fails the next call with `401`.
- AC-9.5 With discovery on, an agent starting from the instance URL finds the MCP endpoint and the rooster skill through `/.well-known/ai-catalog.json`, the skill's `sha256` digest matches, and the documents validate against their published schemas. With `ROOSTER_AGENT_DISCOVERY=off` only the OAuth metadata remains.
- AC-9.6 A user with Google and an OIDC identity unlinks one in Settings → Security and can't unlink the last. An admin's CLI login with `admin` runs `rooster admin reindex`. After the user loses the admin role, the same login gets `403`, and the consent screen never offers `admin` to an OAuth client. An MCP client granted `tasks:delete` through the consent checkbox can call `delete_task`, which moves the task to Trash; without the checkbox the tool is not listed.

---

## Phase 10: Recurrence, reminders, attachments, iCal

| WP | Content |
|---|---|
| 10.1 Recurrence | `packages/core/recurrence` with exhaustive tests; the picker "Repeat" section with presets and custom; NL phrases EN/SV; next-instance creation on completion (same group, directly after; copies per FR-REC-3); "this / this and following" on delete; the row icon. |
| 10.2 Attachments | BlobStore local and S3, streaming upload with a limit, mime sniffing, sharp thumbnails, the pane grid, the lightbox, paste and drop, and purge with the task. |
| 10.3 iCal | Feed tokens, the ICS generator (all-day vs timed VEVENTs, `X-WR-CALNAME` "rooster – Personal"), caching, and the settings UI. |
| 10.4 Task reminders | FR-REM: `task_reminder` with resolved `fire_at` (recomputed in the same transaction as any due-field change, and when the user's timezone or default reminder time changes); the per-minute scheduler claims due reminders (`fired_at`) before sending, fires late up to 24 h; the `reminder` notification type through the existing inbox, push and email delivery and the "Task reminders" matrix row; the date popover's reminder section (Alt+R), the pane line, the phone sheet; the row `bell` indicator (`nextReminderAt`); the `!15m` title token in `packages/core/dates`; CLI `--remind`, TUI (the `d` picker accepts the tokens) and MCP `remind`; recurrence carries relative reminders forward. |

**Acceptance criteria**
- AC-10.1 "Water plants every mon" completed on Monday 2026-10-05 creates the next instance due 2026-10-12, in the same group directly below the old task's position. "every 3 days after done" completed on Oct 7 gives Oct 10.
- AC-10.2 Uploading 30 MB with a 25 MB limit returns 413. Images show thumbnails. A non-member cannot download (404).
- AC-10.3 The ICS validates (icalendar validator), and Google Calendar subscribes successfully (manual check).
- AC-10.4 A task due Fri 14:00 Europe/Stockholm with "1 h before" reminds exactly once at 13:00 local (push and inbox), also across a container restart at 12:59:30. Moving the due time to 15:00 moves the reminder to 14:00. A task completed before 13:00 doesn't remind. The row shows the bell until the reminder fires. `Call Bob fri 14:00 !1h` creates the same task and reminder. Another member of the org sees neither the bell nor the reminder. Completing a weekly recurring task with a relative reminder gives the next instance the same reminder.

---

## Phase 11: Hardening (released as 1.5.0)

Phase 11 changes no API contract, so it is a minor release (ADR 0052). v2.0 waits for a real breaking change.

| WP | Content |
|---|---|
| 11.1 Security | The OWASP ASVS L2 subset in `docs/security/asvs.md`: each chosen requirement, its status and its evidence (a test, a file or an ADR). CI runs `pnpm audit --prod` (a high or critical finding fails) and a gitleaks secret scan (10 §6); the 10 §6 security tests exist. A per-user attachment storage quota (`ROOSTER_USER_STORAGE_MB`, ADR 0052). |
| 11.2 Security audit | See below (AC-11.1). Runs after 11.1 lands. |
| 11.3 Accessibility | axe (WCAG 2.2 AA) on every screen, on desktop and phone; a keyboard-only e2e of the core journey; checks of the list's accessible names against 10 §5; fixes. `docs/accessibility-checklist.md` is the manual pass with VoiceOver (iOS, macOS) and NVDA + Firefox, run by the maintainer per release. |
| 11.4 Performance | A seeded 2,000-task org. Server: `GET /my-list` time with 1,000 and 2,000 tasks, mutation p95 and idle RSS against 10 §4. Web: keypress → paint and scrolling with 2,000 open tasks in My tasks. The bundle budget holds. A look at slimming the Docker image (AGENTS.md Deferred). |
| 11.5 Operations | `GET /admin/system` and the Admin → System page (08 §9: version, DB and WAL sizes, the last backup, job runs, SMTP and push status, SSE connections, attachment storage). The backup and restore drill (10 §3.6) and the migration test from the previous release's fixture DB, both in CI. `compose.litestream.yaml` and its documentation (08 §4). |
| 11.6 Documentation | The user guide in `docs/guide/{en,sv}/` (Markdown, the single source), also rendered in the app at `/help` (lazy, offline, searchable by section, linked from the `?` cheat sheet, the user menu and settings). The keyboard page is generated from `keymap.ts`. The operator guide `docs/operator.md` and `CONTRIBUTING.md`. Screenshots from a seeded demo team (`pnpm docs:screenshots`: desktop and phone, English; light only, D-22) in the guide and the README. |
| 11.7 Spec gaps | The list header's "⋯" menu (02 §2: add group, show completed, collapse all, expand all, export, print, with a print stylesheet) and Settings → Behaviour's missing switches (FR-SET-2: dates in titles on/off, the completion hide delay 1.5 s / 3 s / until reload). |

- **Full security audit** of the whole codebase, not only the diffs reviewed phase by phase, by an independent reviewer with read-only access.
  - **One focused review per trust boundary.** Each brief names the files, the assets and the attacks to try. The boundaries are:
    1. sign-in, sessions and account linking;
    2. the OAuth 2.1 AS, CIMD and token audiences;
    3. grants and service authorisation, including the authz matrix;
    4. `/mcp` and discovery;
    5. uploads, blobs, avatars and calendar feeds;
    6. push, mail and the outbound SSRF guards;
    7. realtime (SSE) and the request middleware (idempotency, rate limits, body limits, client IP);
    8. the web client: XSS, redirects, and local data across sign-out and user switch;
    9. the CLI: the credential store, `safe-write`, `launch` and terminal output;
    10. backups, admin, config, and the Docker image.
  - **One structured pass** over everything since 1.0.0.
  - **Findings:** each is either fixed with a test, or accepted as a risk in an ADR. Each one is mapped to the ASVS checklist item it falls under.
  - **Re-checks:** every boundary is re-reviewed until the review reports it clean.

**Acceptance criteria**
- AC-11.1 The security audit is complete when both of these hold:
  - every trust boundary above has a final re-check reporting it clean, or its remaining findings are triaged (refuted, or accepted with the reason) under AGENTS.md → Reviews;
  - `docs/security/security-review.md` lists each finding with its boundary, ASVS item, severity, and the fixing commit or the ADR that accepts it.
- AC-11.2 CI fails on a high or critical `pnpm audit --prod` finding or a gitleaks hit, and both pass. `docs/security/asvs.md` gives evidence for every listed requirement. An upload that would take a user past their storage quota gets `413 storage_quota_exceeded`, and nothing is stored.
- AC-11.3 axe reports no WCAG 2.2 AA violation on any screen, on desktop or phone. A keyboard-only e2e signs in, creates a task with a natural-language date, adds a subtask, moves, completes and undoes, searches with the palette and changes a setting, without the pointer. A task row's accessible name matches 10 §5.
- AC-11.4 With 2,000 tasks in one org: `GET /my-list` with 1,000 tasks takes ≤ 50 ms server time, the mutation p95 is ≤ 20 ms, and idle RSS is ≤ 150 MB. Keypress → paint stays at a p95 ≤ 50 ms with 2,000 open tasks in My tasks. The initial bundle stays ≤ 500 KB (ADR 0052 §10).
- AC-11.5 CI restores a backup taken by the Docker image into a fresh container and finds the data, and migrates the 1.4.0 fixture DB to the current schema. Admin → System shows every item of 08 §9.
- AC-11.6 `/help` shows the guide in English and Swedish, offline too. `pnpm docs:screenshots` regenerates every screenshot from the seeded demo team. CI fails when the keyboard page no longer matches the keymap. The README shows the screenshots.
- AC-11.7 The header "⋯" menu collapses and expands all groups, toggles completed tasks, adds a group, exports and prints the list (the print shows only the list), and each item has a keyboard path. Turning off dates in titles keeps "fri" literal; the hide delay applies, including "until reload".

---

## Backlog

Work that is specified but not scheduled into a phase. Pick an item up by moving it into a phase (or a minor release after v1.0) and renumbering its WP and AC IDs.


### Dark theme (D-22, Q-03)

Moved here on 2026-10-10 (ADR 0052). Every colour is already a semantic token, so dark mode redefines the semantic layer under `[data-theme="dark"]` (03 §1). The work: a contrast-tested dark token set, a System / Light / Dark choice in Settings → Profile, the PWA theme colour, the brand assets on dark grounds, axe in both themes, and the dark screenshots (the `docs:screenshots` dark projects are ready and skip themselves until then).

### Headless agent access: the device grant and MCP tokens (11 §9, ADR 0065)

Specified 2026-10-21. A minor release: everything is additive, and the legacy CLI device flow stays until the next major.

| WP | Content |
|---|---|
| B.3 Device grant (server) | One better-auth `deviceAuthorization` with a combined rooster grant extension. It branches on `rooster-cli` without `resource` (the legacy session flow) versus an OAuth device request, which stores `oauth_client_id`, `resource` and `request_ip`. `POST /api/auth/oauth2/device-authorization`; the device grant type registered on `/api/auth/oauth2/token` through `extendOAuthProvider`, redeeming with `redeemDeviceCode` and issuing through `issueTokens` with the grant id as `referenceId`. In the mount, the token request handles the new grant (live-grant check, `withGrantScope`). Also: `ROOSTER_OAUTH_DEVICE`; CIMD device clients without `redirect_uris`; hashed codes; the rate limits; no `verification_uri_complete`; the AS metadata in `all` mode; `resolveOAuthToken` accepting `kind:'device'` for `rooster-cli`; the extended review, approve and deny routes; the `device_connected` notice. Migration for the `deviceCode` columns (11 §9.1–9.5). |
| B.4 Approval page and Connected apps (web) | The `/device` page in the "Full context" layout (11 §9.3) for the CLI and apps: Unverified with the host, the code to compare, the request IP and age, the warning, "This session only" for apps, Deny first. The `device_connected` notice in the inbox. Connected apps' New token with "Works with: API · MCP" and the setup lines (11 §9.7). |
| B.5 MCP tokens (server) | PAT `audience` (`api`/`mcp`): `POST /me/tokens`, `/mcp` accepting MCP PATs with the scope pre-check, per-grant rate limits and the no-step-up error, `/api/v1` refusing them, no `admin` (11 §9.7). |
| B.6 CLI | `rooster login` on the device grant (refresh serialised per profile across processes), `rooster logout` revoking the refresh token, `rooster mcp header`, `rooster mcp setup --remote`, `rooster token create --audience mcp`, and the fallback to the legacy flow when the server answers `unauthorized_client` (11 §9.6). |

**Acceptance criteria**
- AC-B.3 With `ROOSTER_OAUTH_DEVICE=all`:
  - A CIMD client listing the device grant (and no `redirect_uris`) starts a flow with `resource=<host>/mcp`. The response has no `verification_uri_complete`. Polling yields `authorization_pending`, and `slow_down` when it polls too fast.
  - The user types the code at `/device` and sees the client as Unverified with its host, the request IP and the warning. They allow `tasks:read` on one org.
  - The client gets an access and a refresh token and lists that org's tasks at `/mcp`. The token is refused by `/api/v1`. The device code can't be redeemed twice. A refresh reused after rotation revokes the grant.
  - The user gets a `device_connected` notice (and an email with SMTP).
  - With `first-party`, the same client gets `unauthorized_client` and the AS metadata lists no device endpoint. With `off`, `rooster-cli` gets it too.
- AC-B.4 Ten wrong codes within 10 minutes lock code entry for that user with `429`. Codes are stored only as hashes. Approve and deny with another session's nonce are refused.
- AC-B.5 A PAT created with audience `mcp` and `tasks:read` lists tasks at `/mcp` from a client given only a static `Authorization` header, gets `403` naming `tasks:write` for `create_task`, and is refused by `/api/v1`. An `api` PAT is refused by `/mcp`. Revoking the token fails the next call with `401`.
- AC-B.6 `rooster login` on a new instance completes through the device grant, survives an access-token expiry by refreshing (two concurrent commands don't revoke the grant), and `rooster logout` revokes it. A CLI device session created by 1.7 still works. `rooster mcp setup --remote --client claude-code` writes a config with `rooster mcp header` as the header helper, and `rooster mcp header` prints a working `/mcp` token.

### Security hardening (the open ASVS L2 gaps)

These were accepted for 1.5.0 (ADR 0054 §10, `docs/security/asvs.md`):
- malware scanning of uploads (12.4.2);
- self-service account deletion (8.3.2);
- an SBOM for release images (14.2.5), e.g. `buildx --sbom=true` in `release.yml`;
- step-up re-authentication for sensitive actions, since sessions are 30-day rolling (3.3.2, 3.7.1);
- a written threat model and data classification (1.1.2, 1.8.1).

### Phase 11 follow-ups

- **OAuth and MCP:**
  - Refuse client redirect URIs on rooster's own origin at registration, for both CIMD and DCR. Today they are refused at consent (ADR 0056).
  - Show the OAuth client's name in activity ("via Claude (MCP)", 11 §2.3).
- **Web:**
  - The Profile time-zone combobox opens its list on focus (`menuTrigger="focus"`). Revisit for screen readers.
  - The 429 text for avatar removals reuses the upload message.
- **CLI:** `rooster comment` sends `@Name` as plain text. Resolve mentions as the web does.
- **Server, whenever touched:**
  - `UserService.reorderOrg` moves onto `OrderingService` (ADR 0005).
  - The retention purge publishes SSE events (ADR 0009).
