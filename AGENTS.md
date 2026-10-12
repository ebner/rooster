# AGENTS.md: rules for implementing agents

You are implementing **rooster**, a self-hosted, keyboard-first task manager. The specification in `docs/spec/` is the source of truth. Read it before writing code.

## Read first (in this order)
1. `docs/spec/00-overview.md`: decisions (D-xx) are **binding**.
2. `docs/spec/09-phases.md`: find your phase and work package (WP). Implement only that scope.
3. The specs your WP touches: `02-ux-interaction` (behaviour), `03-design-system` (visuals; binding), `04-architecture`, `05-data-model`, `06-api`, `07-cli`, `11-agent-access` (grants, OAuth, MCP, discovery; P8/P9).
4. `docs/spec/10-quality.md`: the Definition of Done.

When documents conflict, the precedence is **00 > 05 > 06 > 02 > 03 > others**. Flag every conflict in your PR description. Never silently invent behaviour: if the spec is silent, choose the option most consistent with "the list is a text editor" and common task-manager conventions, and record it as an ADR in `docs/adr/NNNN-title.md`.

## Repository map
Entries marked *(planned)* do not exist yet. Create them in the phase that introduces them.
- `apps/server`: Hono API.
  - `src/main.ts`: boot (config → db → pre-update backup on a version change or pending migrations (ADR 0023) → migrate → app → listen → scheduler).
  - `src/app.ts`: the pure `createApp(deps)`, used by tests.
  - `src/config.ts`: zod env schema. **Every env var lives here and in `.env.example`.**
  - `src/lib/`: errors (problem+json), logger, request id/log (invite tokens redacted), security headers, SPA serving (never `*.map` or dot-paths), graceful close, `body-limit.ts` (64 KB `/api/auth`, 1 MB `/api/v1`), `client-ip.ts` (right-most `ROOSTER_TRUSTED_PROXY_HOPS` entry), `log-safe-error.ts` (**log errors through `logSafeError`**: SQL parameters are user content).
  - `src/routes/`: one file per resource. Route zod schemas come from `@rooster/core/schemas`, registered in `routes/schemas.ts` with `.openapi('Name')`.
  - `src/auth/`: the better-auth instance (`auth.ts`), mounting under `/api/auth/*`, actor resolution (`actor.ts`), and signed cookies (`__Host-` prefixed on https). better-auth handles **authentication only**; orgs are ours (ADR 0002). Account linking by email only from email-authority providers (Google, `trustEmail`; ADR 0017).
  - **P9 OAuth 2.1 AS** (ADRs 0041, 0045): better-auth's `@better-auth/oauth-provider` + `@better-auth/cimd` (pinned exactly; issuer `<base>/api/auth`, endpoints `/api/auth/oauth2/*`). `mount.ts` canonicalises token requests and serialises refresh reuse per token (`keyed-lock.ts`); `oauth-handoff.ts` carries the rooster grant id to the provider's `referenceId`; `oauth-bearer.ts` `resolveOAuthBearer(services, token, 'mcp'|'api', ip)` is the only way to turn an OAuth token into an actor (audience-bound); `oauth-metadata.ts` builds RFC 8414/9728 documents and `WWW-Authenticate` challenges; `cimd-fetch.ts` is the DNS-pinned public-address fetch for Client ID Metadata Documents. No DPoP, no `openid`, `resource` required.
  - `src/services/`: `OrgService`, `UserService`, `AdminService`, `GroupService`, `TaskService` (incl. subtasks and duplicate), `TagService`, `PlacementService` (the 05 §4.1 invariant), `OrderingService` (all fractional keys are computed server-side), `BackupService`, `SearchService` (FTS5 queries), `ExportService` (JSON/Markdown), the P6 collaboration services `CommentService`, `ActivityService` (the activity writer, called in the same transaction as each task change), `FollowerService` and `NotificationService` (in-app fan-out in the same transaction; ADR 0029), and `sign-in-policy.ts` (the allowlist rules). **All authorisation lives here.** `cursor.ts` has the opaque page cursors.
  - `services/context.ts`: `immediate()` for writes, `readOnly()` (DEFERRED) for read-only service methods.
  - `services/search-index.ts`: `indexTasks(tx, ids)` keeps `task_fts` in step (title, description and live comments). **Call it in the same transaction from any new write that changes a task's title, description, comments or `deleted_at`** (ADR 0013). Boot rebuilds the index when its row count is off; `POST /admin/search/reindex` rebuilds it on demand.
  - Request middleware covers idempotency (`Idempotency-Key`), edit time (`X-Rooster-Edit-Time`, clamped), client id/name, and the per-user rate limit. ADR 0005 has the list semantics.
  - `src/db/`: client and pragmas, `migrate.ts`, `schema/`, `migrations/` (generated, append-only). Hand-written migrations (FTS, triggers, pragmas only) are created with `pnpm --filter @rooster/server exec drizzle-kit generate --custom --name <name>`, statements separated by `--> statement-breakpoint`; `0004_task_fts.sql` is the example.
  - `src/jobs/`: croner scheduler. Per-user timed sends (the due reminder, the digest) run every minute, claim `job_run(job, "<userId>|<local date>")` **before** sending, and use a 10-minute grace window (`services/job-runs.ts`, ADR 0035).
  - **P10:**
    - `src/blob/`: `BlobStore` local or S3 (`store.ts`, `s3-store.ts`; keys validated in `keys.ts`), `multipart.ts` (streamed busboy upload into `<dataDir>/tmp` with the limit), `content.ts` (`file-type` sniffing, file-name cleaning, sharp thumbnails), `gc.ts`.
    - **Never delete blobs inline:** the `attachment_blob_gc` trigger queues the keys of every deleted `attachment` row in `blob_gc`, and the blob GC job deletes them after commit. Avatars are stored once per upload (`avatars/<userId>.<avatar_id>`, a UUIDv7) and replaced ones go to `blob_gc` too (ADR 0056); only 1.4.x avatars still use the old shared key.
    - The upload routes are exempt from the 1 MB API body limit (`isUploadRequest` in `lib/body-limit.ts`) and enforce their own limit.
    - Private downloads are `Cache-Control: private, no-cache` with an ETag, and answer 304 only after the access check.
    - `src/ical/ics.ts` (RFC 5545 output) behind `/ical/<token>.ics` (`routes/ical.ts`; tokens are hashed, misses are limited per IP, and the request log redacts them).
    - Services: `RecurrenceService` (the next instance on complete or skip; with a grant, the whole subtree must be writable), `ReminderService` (`fire_at` resolution with core `resolveFireAt`, re-resolved in the same transaction as any due-unit, timezone or `allDayReminderTime` change; the `task-reminders` job claims each reminder before sending), `AttachmentService`, `AvatarService` and `IcalService`. ADR 0049.
  - `src/push/` (P7): VAPID keys (`vapid.ts`: env or generated into `instance_setting` at boot), `push-service.ts` (subscriptions, sends after commit through `lib/task-queue.ts`, 404/410 removes a device). **Every send re-checks `isAllowedPushEndpoint`** (SSRF, ADR 0033).
  - `src/mail/` (P7): the nodemailer transport (only with `ROOSTER_SMTP_URL`), React email templates rendered with `@react-email/render` (`templates/`, tables and inline styles from `@rooster/tokens`, text in the `mail` i18n namespace), `mail-service.ts` (invites, immediate and batched notification emails, the digest) and HMAC unsubscribe tokens. `routes/unsubscribe.ts` serves `/unsubscribe/:token` outside `/api/v1`: GET only confirms, POST unsubscribes.
  - `src/mcp/` (P9, ADRs 0042, 0043): the remote `/mcp` endpoint (Streamable HTTP, stateless). Checks run origin → method → token → headers → bounded body → scope pre-check (`requiredScopes`) → per-grant rate limit → SDK. Tools run against the REST API **in-process** (`in-process-client.ts`, `IN_PROCESS_ACTOR` from `lib/in-process.ts`), so service authorisation applies unchanged and the token is never forwarded. `routes/discovery.ts` serves the Server Card (`/mcp/server-card`), `/.well-known/ai-catalog.json`, the agent-skills index and `SKILL.md`, and `/llms.txt` (off with `ROOSTER_AGENT_DISCOVERY=off`).
  - `src/events/`: the after-commit `EventBus` and the SSE `hub` behind `GET /api/v1/events`. Services publish through the per-transaction queue, and audiences are computed in `services/event-audience.ts`. `DomainEvent.direct` carries per-user messages other than invalidations (the SSE `notification` event). ADR 0009.
  - **Security audit rules** (ADR 0056):
    - **Bind every approval to the session that showed it.** A page that applies a decision (OAuth consent, device approval) returns a `decisionNonce` with the request (`decisionNonce()` in `grant-service.ts`), and the decision must send it back.
    - **Nothing that exports a credential is reachable.** Keep better-auth's `DISABLED_PATHS` (in `auth.ts`) covering account and session endpoints rooster doesn't use.
    - **Grants never see colleagues' emails:** member lists drop them, `@person` matches names, and assignees resolve through `GET /orgs/{orgId}/members/resolve`.
    - **Bounded work:** request bodies go through `readBodyBounded`, SSE through `events/sse-transport.ts`, uploads through `blob/upload-slots.ts` (3 per user, counted against the quota while streaming), and deliveries through the keyed, capped `lib/task-queue.ts` (`run(name, task, key)`). Push allows at most 20 devices per user.
    - **Unlinked identities stay blocked** (`unlinked_identity`, better-auth's `account.create.before` hook) until allowed again.
  - **P11** (ADRs 0052, 0054):
    - **Storage quota:** `ROOSTER_USER_STORAGE_MB` (per uploader; `userStorageUsed()` in `services/attachment-queries.ts`). It is checked after streaming and again in the transaction that inserts the attachment row.
    - **Admin → System:** `SystemService` behind `GET /admin/system`. Job runs live in memory in `jobs/job-board.ts`; the scheduler records into it.
    - **Defaults:** `/api/v1` responses without their own cache policy are `no-store`, and the DB files are made 0600 at boot.
    - **Never use `fileTypeFromFile`:** its runtime import can't be resolved in the bundled `dist/main.js`, which broke uploads in the 1.4.0 image. Sniff through `fileTypeFromBlob(await openAsBlob(path))`. Anything imported at runtime by a computed specifier must be checked in the built image (the backup drill uploads a file).
  - Tests live in `test/`. Helpers: `createTestDb`, `createTestApp`, `mock-idp.ts`, `signInAs(email)`.
    - `test/server.perf.test.ts` holds the AC-11.4 server budgets: `*.perf.test.ts` files are left out of the coverage run and run alone in their own CI step (`pnpm --filter @rooster/server test:perf`; `ROOSTER_PERF_SLACK` loosens them on slow machines).
    - `test/migration-fixture.test.ts` migrates the previous release's dump, `test/fixtures/release-<version>.sql`. **Refresh it at each release** with `make-release-fixture.ts`; its header says how.
  - `test/authz.matrix.test.ts` enumerates **every** OpenAPI route; a new route without a matrix row fails it.
  - The build bundles **all** JS deps into `dist/main.js`, except native modules (`NATIVE_DEPS` in `tsdown.config.ts`). Add a native dependency there **and** in `docker/Dockerfile`.
- `apps/web`: React SPA (+ PWA from P4).
  - `src/routes/`: TanStack file routes. `routeTree.gen.ts` is generated and committed. `src/routes/[_dev]/ui.tsx` is the dev-only kitchen sink at `/_dev/ui`; the brackets escape the underscore.
  - `src/ui/`: Coop components. Brand (03 §2.10, ADR 0026): `brand.ts` is the **single source** of the mark and the outlined wordmark; `logo.tsx` has `LogoMark` (`animated` draws it in once per load: signed-out screens only), `Wordmark` and `Logo` (`row`/`stack`). Never draw the rooster anywhere else. Phone pieces (P4): `BottomSheet`/`SheetOption`, `BottomNav`, `Fab`, `AccessoryBar`, `SwipeReveal`; `use-media.ts` (`useBreakpoint`, `useIsMobile`, `isMobileViewport`, `useKeyboardInset`, `useEditingFocus`); `use-drag-dismiss.ts` (swipe-down sheets).
  - `src/features/*`:
    - shell (sidebar, `scroll-reset.ts` (which scrollers a navigation returns to the top: `[data-scroll-main]`, `[data-list-column]`, `[data-pane-scroller]`; a new page-level scroller goes there), app frame per breakpoint: desktop sidebar/rail, tablet rail that expands over the content, phone frame (pinned `fixed inset-0`, document locked, no overscroll; ADR 0020) with `MobileHeader` (optional `back` link) + org switcher sheet + view switcher and `MobileNav`), auth, org-settings (incl. the Tags section), settings (incl. Behaviour: swipe actions; Data: export and Trash; on phones `/settings` is an index you drill into, `settings-index.tsx`), admin (including backups)
    - views (smart views Today / Next 7 days / Overdue / No date over core `selectView`: `view-counts.tsx` (live sidebar badges), `view-tabs.ts` (phone switcher), `last-view.ts`; routes `o.$orgSlug._tasks.{today,week,overdue,nodate}.tsx`; the rows come from `list/model/view-rows.ts`; ADR 0015)
    - palette (Ctrl+K, lazy chunk: search, offline filtering over cached lists, recents, actions from the keymap registry via `runShortcut`; `commands.ts` is how a screen publishes argument-taking commands such as `makeSubtaskOf`; ADR 0014)
    - people (assignment and Everyone's tasks: `AssigneePicker`/`AssigneeSheet`, `AssigneeField` for the pane, row avatars, the `@name` token adapter, the Everyone row model, member section headers and filters; ADR 0032)
    - collab (the pane's activity feed and comment rendering, the comment composer with `@` suggestions and drafts, followers, `/inbox`, the sidebar/bottom-nav Inbox badge (`LiveInbox`), Settings → Notifications; ADR 0031)
    - list (My tasks, the smart views and Everyone's tasks: rows incl. subtasks and tag chips, editing model, DnD (own body-level drag preview, no self-adjacent drop targets; ADR 0018), bulk bar, `controller` holding every command incl. `makeSubtaskOf`; the UI store is injectable via `ListStoreContext`). Phones: `mobile-list-chrome.tsx` (FAB, accessory bar, selection mode, sheets), `swipe-rows.tsx` + `gestures.ts` (swipes), `pull-to-refresh.tsx`; ADR 0011.
    - pane (the detail pane: split/overlay (tablet: with scrim)/full screen, and the phone's full-screen sheet with `SheetHeader`; its state lives in the URL `/o/:slug/t/:taskId`)
    - tags (picker, chips, `#tag` token)
    - editor (`MarkdownEditor` on Tiptap, `markdown.ts` converter, a 40-sample round-trip corpus; Ctrl/⌘+click opens links, ADR 0022)
    - dates (`DateLabel`, `DateCell`, `DatePopover` incl. start-date ranges, `useViewerDateContext`; P10: `repeat-section.tsx`, `reminder-section.tsx`, `reminder-chips.tsx`, `recurrence-text.ts` (localises core `describeRule`))
    - attachments (P10: the pane's `AttachmentsSection` (lazy), uploads through XHR in `src/data/attachments.ts` with progress, paste and drop caught on `[data-pane-root]`, the `lightbox.tsx` keymap scope `lightbox`); Settings → Calendar feed (`settings/calendar-feeds.tsx`) and the Profile avatar (`settings/avatar-field.tsx`)
  - **Bundle budget (10 §4, ADR 0016):** UI that appears only on interaction (popovers, the editor, the palette, the better-auth client) is loaded with `lazyWithPreload` (`src/lib/lazy.ts`) and warmed by `InteractionPrefetch`. On the initial route, import constants from `@rooster/core/limits` and i18n helpers from `@rooster/i18n/core`; value imports from `@rooster/core/schemas` or `@rooster/i18n` pull in zod or every catalog. `pnpm bundle:check` fails CI above 500 KB gzip (ADR 0052 §10).
  - `src/data/`: **the only place that talks to the API.** TanStack Query hooks over `createRoosterClient()`, query keys in `query-keys.ts`, problem+json mapped to `ApiError` in `errors.ts`, and better-auth client calls in `auth.ts` / `auth-client.ts`. Components take props; route components call `src/data` hooks. P6: `everyone.ts` (`['everyone', orgId, 'open']`, a flat `Task[]` the pipeline writes to), `collab.ts` (the activity infinite query), `notifications.ts` (inbox, unread count, prefs; online-only). `session-events.ts` and `session-bound.ts` (`useRefetchWhenSessionClears`): **a mutation that writes `/me` or rolls a session cache back checks `sessionScope().stale()` first, and a page holding a `decisionNonce` re-fetches when the session clears** (ADRs 0051, 0056).
  - `src/routes/_app.tsx`: the signed-in layout. Its `beforeLoad` guard redirects to `/login?redirect=…`.
  - `src/lib/`: `cn`, `ui-scale.ts` (`uiScale()`), i18n (loads only the active locale via `@rooster/i18n/lazy`; `main.tsx` awaits `i18nReady`), `lazy.ts`, platform, `safe-redirect.ts`, and `user-storage.ts` (**per-user localStorage keys go through `userStorageKey()`**, swept on sign-out, 401 and user switch). **Every redirect target must go through `safeRedirectPath()`.**
  - `src/data/pipeline/`: the **mutation pipeline**. Every list op goes `enqueue → core reducer on the cache → send (Idempotency-Key, edit time, client id) → merge`. Undo pushes inverse ops through it. Ops are written to the IndexedDB outbox before they are sent; only the leader tab sends. Comment and follow ops go through it too (ADR 0028). Caches without a confirmed base (Everyone, activity) replay the queue in their query functions via `pipeline.withPendingTasks` / `withPendingActivity`; `usePendingEntity` (`pending.ts`) tells whether an entity still has queued ops (ADR 0030).
  - `src/data/sync/`: offline and realtime (04 §6, P4). `engine.ts` (`startSync`, awaited in `main.tsx` before the first render) restores the persisted query cache (`persist.ts`, idb-keyval key `rooster-cache-v1:<userId>`, one per account: a start reads only the browser owner's key and deletes every other, cleanup deletes by the ending account's key (ADR 0056); `my-list` is stored as the confirmed base, never the optimistic view) and the outbox (`outbox.ts`), elects the flushing tab (`leader.ts`, Web Locks `rooster-outbox`), mirrors queue/confirmations across tabs (`channel.ts`, `BroadcastChannel('rooster')`) and runs the SSE client (`events.ts`). Sign-out calls `clearLocalData()`. Persisted query roots need `gcTime: Infinity` (a 30-day timer overflows). Outbox records carry their `userId`; the persisted cache is dropped when its last confirmed `/me` is older than 30 days; every fresh `/me` prunes orgs the user left (ADR 0017). A page that ran as one account reloads when `/me` names another (ADR 0051). **Per-user state outside the query cache subscribes to `onSessionDataCleared` (`data/session-events.ts`), and a request that can outlive its session takes a `sessionScope()`.** A visible follower steals the outbox lock from a silent (frozen) leader, list requests time out after 20 s, and every tab reconciles with the IndexedDB outbox (ADR 0019; test helper `fake-locks.ts`, e2e `sync-recovery.mobile.spec.ts`).
  - `src/sw.ts`: the service worker (vite-plugin-pwa `injectManifest`, own `tsconfig.sw.json`). Off in `vite` dev unless `VITE_PWA_DEV=1`. It shows push messages, routes notification clicks, re-subscribes on `pushsubscriptionchange`, and leaves server paths (`/api`, `/ical`, `/unsubscribe`, health) to the network. `src/data/push.ts` (a lazy chunk) turns push on per device from a user gesture (ADR 0034). `src/features/pwa/`: registration, the update gate and `update-controller.ts` (FR-PWA-6: toast plus a persistent header "Update" chip, `update-chip.tsx`; foreground checks; reload fallback without a service worker; ADR 0021), install prompts, the iOS tip sheet, and `SyncStatus` (the header sync pill and update chip; every header uses it).
  - `src/state/`: Zustand stores for list, undo and sync. **Per-row UI state goes through `useRowUi`, with its fields listed in `changedRowIds`** (`list-store.ts`), so a change re-renders only the rows it touches (ADR 0055).
  - **List rendering (ADR 0055):** task rows are rendered in sticky chunks (`features/list/row-chunks.tsx`), and `content-visibility` applies to whole chunks on screen only. The list root is block layout. There is no virtualisation: the DOM stays complete for keyboard, drag and drop, screen readers and print.
  - **P11 web:**
    - **The guide:** `features/help/` (ADR 0053). `guide-build.ts` is a Vite plugin that turns `docs/guide/**` into `virtual:rooster-guide/<locale>` at build time, with GitHub-style heading ids; it is registered in `vite.config.ts` and `vitest.config.ts`. `guide-view.tsx` renders `/help` and `/help/<slug>`. `keyboard-doc.ts` generates the keyboard page. `whats-new.ts` (ADR 0057): after an update, a toast offers the version's section of the What's new page once per account and browser; Settings links to the page.
    - **Admin:** `features/admin/system-section.tsx` (Admin → System, with search reindex) over `data/system.ts`.
    - **The list header:** `features/list/header-actions.tsx` holds the ⋯ menu. `styles/print.css` prints only the list (`<html data-print="list">`). `hide-delay.ts` holds the until-reload value, 10000.
    - **Accessible names:** `features/list/row-name.ts`.
  - `src/keymap.ts`: **the single keymap registry** (02 §6). `useKeymap()` is mounted once at the root. The `?` cheat sheet is generated from it.
    - Focus zones `list` / `pane` / `paneList`; handlers return `false` to fall through.
    - `[data-no-chords]` disables Tab chords (the editor).
    - ADRs 0006 and 0008 have the details.
  - `src/styles/theme.css`: token → Tailwind mapping.
  - `e2e/`: Playwright tests.
    - The config starts the mock IdP, the server (with a fresh temp data dir) and Vite.
    - PWA specs (`*.pwa.spec.ts`, project `pwa`) run against the production build: the config runs `vite build` and starts a second server on :3182 serving `apps/web/dist` (`ROOSTER_WEB_DIR`). `*.pwa-last.spec.ts` (project `pwa-update`, AC-4.7) rewrites `dist/sw.js` and runs after them.
    - Agents running Playwright in parallel serialise on a lock: `flock /tmp/rooster-e2e.lock pnpm --filter @rooster/web exec playwright test …` (the suites share ports).
    - Phone specs (`*.mobile.spec.ts`) run in the `mobile` (iPhone 15, WebKit) and `mobile-android` (Pixel 8) projects; `e2e/support/touch.ts` has `swipe`, `longPress` and `showKeyboard` (visualViewport emulation). Reload with `reload(page)` from `support/test.ts`, never `page.reload()`: WebKit sometimes reports "Frame load interrupted".
    - `ROOSTER_E2E_PERF=skip|only` leaves out or isolates the `perf` project (CI shards the rest). `expectAxeClean` re-checks a violation twice before failing, since axe can read a transition mid-way.
    - `e2e/support/` has `signInAs`, `newClient` and `apiCall`. The sign-in identity is chosen with `login_hint`, and each browser sends its own `X-Forwarded-For` so the per-IP auth rate limit isn't shared.
- `apps/cli`: the `rooster` CLI (P8), its TUI and the stdio MCP server (P9). It uses only the public API, through `@rooster/api-client` (`src/api.ts`).
  - Source:
    - Entry: `src/main.ts` → `run.ts` → `cli.ts` (citty).
    - Commands: `src/commands/*`.
    - Output: `src/output/*` (token colours, truecolor → 256 → ANSI, `NO_COLOR`).
    - Infrastructure: `refs.ts` (`@last`, stdin; everything else via `GET /tasks/resolve`), `config.ts` (TOML profiles), `secrets.ts` (keychain via a lazy `@napi-rs/keyring`, 0600 file fallback), `errors.ts` (exit codes 07 §4.2), `launch.ts`, `i18n.ts`, `completion.ts`.
    - P9: `commands/{mcp,skill,admin}.ts` (`rooster mcp [setup]`, `rooster skill print|install`, `rooster admin reindex`); `mcp-config.ts` (client configs for `mcp setup`); `tui/**` (Ink 8, lazy-loaded chunk; `KEYMAP` in `tui/keymap.ts` generates `?` help; `tui/sse.ts`; `tui/idempotency.ts` keeps one Idempotency-Key per logical change across retries; ADR 0047).
  - **Options are read with `readOptions` (`commands/util.ts`)**, with real option boundaries: a missing value, or one that looks like another option, is a usage error (exit 2). Server responses are untrusted: validate numbers and instants and `clean()` text before printing.
  - **Diagnostics go through `safeDiagnostic` (`diagnostics.ts`)**: error messages and `--verbose` stacks are redacted (credentials) and cleaned (control characters) before printing; tokens are checked with `isBearerToken` before any header is built (ADR 0056).
  - **`safe-write.ts` is the only way to write files outside the CLI's own config** (other apps' MCP configs, `SKILL.md`): exclusive `O_NOFOLLOW` temp file, every byte written, directories pinned by dev/ino, refuse on change, delete only what it created (ADR 0044).
  - **`launch.ts` is the only way to open a browser or `$EDITOR`:** argv only, never a shell, and only https URLs on the profile's server origin (ADR 0039).
  - Strip control and bidi characters from user content before printing (`output/format.ts`).
  - Tests: `apps/cli/test`. Integration tests run against an in-process server (`test/support/rooster-server.ts`). AC-8.1 is the e2e `apps/web/e2e/cli.mobile.spec.ts`.
  - The build bundles everything into `dist/rooster.mjs` plus lazy chunks (the TUI), except the optional `@napi-rs/keyring` (`NATIVE_DEPS` in its `tsdown.config.ts`). Ink's `react-devtools-core` is aliased to a no-op stub: an unresolved external makes Bun-compiled binaries crash at startup. `scripts/build-binaries.sh` (Bun) runs in the release workflow.
- `packages/core`: **pure** TS (no IO, no `Date.now()` inside functions):
  - `ids` (uuidv7)
  - `ordering` (fractional keys)
  - `dates` (iso helpers, `dueState`, `formatRelative`, and the NL parser `parseDatePhrase` / `findDateInTitle` / `findGroupToken`; ADR 0004)
  - `views` (`selectView`, `viewCounts`, `inSmartView`: smart views shared by the web and `?view=`; ADR 0012)
  - `recurrence` (P10: the RRULE subset; `parseRule`/`formatRule`, `normalizeRule` (anchors made explicit from the due date), `nextOccurrence`/`nextInstance`/`firstOccurrence`, `recurrencePresets`, `describeRule`) and `reminders` (`dueMoment`, `resolveFireAt`, reminder offsets); the NL parser reads recurrence phrases (`DateParseResult.recurrence`) and `findReminderTokens` finds `!15m`/`!1h`/`!1d`/`!due` (ADR 0049)
  - `everyone` (`selectEveryone`, `applyOpToTaskList`), `activity` (`groupActivity` and the activity-cache helpers), `comment-markdown` (the safe Markdown-light comment AST), `mentions` (`@[Name](user:<id>)`); `dates` also has `findAssigneeToken`, shared by the web and the server's `parse: true` (ADR 0030)
  - `search` (`parseSearchQuery`, `toFtsMatch`, `matchesTask`, `matchesFilters`, `fuzzyScore`: the search grammar shared by the server's FTS and the palette's offline filter; ADR 0012)
  - `reducers` (`applyOp`, `inverseOf`, `mergeResponse`). These are the optimistic client-side mirror of the server semantics in ADR 0005; **change both together**.
  - `schemas` (shared zod); `limits` (zod-free constants that `schemas` re-exports) and `sse` (zod-free SSE payload guards) for the web's initial bundle

  Imported as `@rooster/core/<module>`.
- `packages/mcp` (P9, ADRs 0042, 0044): the MCP tools shared by `rooster mcp` (stdio) and `/mcp`: `createRoosterMcpServer` (tools over `@rooster/api-client` only; `granted` vs `step-up` listing), `tools.ts` (`requiredScopes`, the capability map of 11 §5.2), `format.ts` (user content goes out only as framed, escaped data blocks for the assistant), `skill.ts` (`skillMarkdown`, deterministic per instance URL, and the short `skillInstructions`).
- `packages/api-client`: `schema.d.ts` is **generated** from `apps/server/openapi.json` (`pnpm gen:api`), so do not edit it. `src/index.ts` wraps it as `createRoosterClient()`.
- `packages/i18n`: `locales/{en,sv}/<namespace>.json` (ICU messages). `.` bundles every catalog (`createI18n`/`initI18n`; server, CLI, tests), `./core` has the catalog-free helpers (`detectLocale`, `isLocale`, namespaces), `./lazy` loads one locale per chunk (`initLazyI18n`, `ensureLocale`; the web). A new namespace goes in `core.ts` and both `catalog-*.ts`.
- `packages/tokens`: Coop tokens. `src/tokens.css` and `src/index.ts` must agree. A contrast test guards every allowed pair.
- `docker/`: `Dockerfile` (distroless, nonroot) and `proxy/` snippets. `compose.yaml` sits at the root.
- `scripts/`:
  - `ci.sh` (the whole pipeline, in stages `static`, `unit`, `build`, `e2e`; `.github/workflows/ci.yml` runs one job per stage over the `.github/actions/setup` composite action), `release.sh` (cuts a release locally: refuses a stale migration fixture, missing notes (CHANGELOG or What's new) or an unlisted migration before bumping, then runs the pipeline; push main, wait for CI, then push the tag), `docker-smoke.sh`, `i18n-check.mjs`, `bundle-budget.mjs`, and `dev-idp.mjs` (a mock OIDC provider for local dev and tests).
  - P11:
    - `secret-scan.sh`: gitleaks over the history. Reviewed fixtures are pinned in `.gitleaksignore`.
    - `backup-drill.sh <image>`: backup, restore and verify, including an upload.
    - `perf/server-rss.mjs`: idle RSS against the 150 MB budget.
    - `docs/keyboard.mjs` and `docs/screenshots.sh`, which seeds the Kestrel Lane demo team and captures `docs/screenshots/`. Each PNG records its density and window width (`docs/png-meta.mjs`), which `guide-build.ts` uses to show it at its real size and a crop at its window's scale; images written on adjacent lines sit side by side in the guide.
- `compose.litestream.yaml`: the optional Litestream sidecar (`docs/operator.md`).
- `.github/workflows/`: `ci.yml`, and `release.yml` (a pushed `vX.Y.Z` tag builds, smoke-tests and publishes the image to GHCR as `x.y.z`, `x.y`, `x` and `latest`; the tag must equal the root `package.json` version).
- `CHANGELOG.md` (Keep a Changelog; list every migration), `README.md` (the front page with screenshots), `CONTRIBUTING.md`, `docs/oidc-setup.md` (sign-in provider guide), `docs/operator.md` (the operator guide), `docs/guide/{en,sv}/` (the user guide, also in the app at `/help`; `pages.json` orders it; **`keyboard.md` is generated, never edit it by hand**; `whats-new.md` holds the release notes for users), `docs/security/asvs.md` (the ASVS L2 map), `docs/accessibility-checklist.md` (the manual screen reader pass per release).
- `docs/spec/` (the spec; `09-phases.md` §Backlog holds specified but unscheduled work), `docs/adr/` (decisions made during implementation).

## Commands
```
pnpm i                         # install (pnpm 12 via corepack; Node 24)
pnpm --filter @rooster/web exec playwright install chromium webkit   # once, for e2e (webkit: the iPhone project)
pnpm dev:idp                   # mock OIDC provider on :9400 (start BEFORE pnpm dev; signs in as dev@example.com)
pnpm dev                       # server (:3000, tsx watch) + web (vite :5173, proxies /api)
pnpm build                     # all packages (web → apps/web/dist, server → apps/server/dist)
pnpm test                      # vitest, all projects
pnpm test:coverage             # vitest + coverage gate (run unfiltered: globs are repo-relative)
pnpm e2e                       # playwright (apps/web/e2e)
pnpm lint / pnpm format / pnpm typecheck
pnpm gen:api                   # emit apps/server/openapi.json, then regenerate packages/api-client
pnpm i18n:check                # en/sv parity, ICU validity, unused keys
pnpm bundle:check              # initial JS for /o/:slug/my ≤ 500 KB gzip (after pnpm build; ADRs 0016, 0052)
pnpm --filter @rooster/cli dev -- ls   # run the CLI from source (ROOSTER_SERVER / --server, ROOSTER_KEYRING=off for tests)
pnpm --filter @rooster/cli smoke  # build output against an in-memory server: --version, login --with-token, whoami
pnpm --filter @rooster/cli dev    # with no arguments on a terminal: the TUI; `-- mcp --profile agent` serves MCP on stdio
apps/cli/scripts/build-binaries.sh  # single-file binaries for 5 targets (needs Bun; run by the release workflow)
pnpm db:generate               # drizzle-kit generate + STRICT post-processing
pnpm run ci                    # full pipeline (scripts/ci.sh; plain `pnpm ci` is pnpm's own command); `--with-docker` adds image build, smoke and backup drill
pnpm run ci unit e2e           # only the named stages (static | unit | build | e2e | e2e-perf); CI runs each as a parallel job
ROOSTER_E2E_SHARD=1/3 pnpm run ci e2e   # one e2e shard without the timing budgets; `pnpm run ci e2e-perf` runs those alone (CI: 3 shards + e2e-perf)
pnpm release X.Y.Z [--check]  # write the CHANGELOG [Unreleased] notes, both What's new "## Unreleased" sections and the AGENTS.md "Latest release" line first; preflight, bump, the whole pipeline with the image and no e2e retries, then a local commit and tag (never pushes)
node apps/web/scripts/render-icons.mjs   # regenerate favicon, logo SVGs and app icons from src/ui/brand.ts
pnpm docs:keyboard [--check]   # regenerate (or check) docs/guide/{en,sv}/keyboard.md from keymap.ts
pnpm docs:screenshots          # seed the demo team and capture docs/screenshots (uses the e2e ports and lock; DOCS_SHOTS=a,b limits the shots)
bash scripts/backup-drill.sh <image>      # backup/restore drill against a built image (Docker + Node; also in CI)
node scripts/perf/server-rss.mjs [--image <tag>]   # idle RSS with 5 users (≤ 150 MB)
```
**Local dev:**
1. Copy `apps/server/.env.example` to `apps/server/.env`, set `ROOSTER_AUTH_SECRET` (`openssl rand -base64 48`; weak secrets exit 78) and uncomment the "Local development with the mock IdP" block.
2. Run `pnpm dev:idp`, then `pnpm dev`, then open http://localhost:5173 and use "Dev login".
3. To switch the identity for the next sign-in, call `curl -XPOST localhost:9400/__next-user -d '{"email":"bob@example.com"}'`.

At least one sign-in provider must be configured, or the server exits with code 78.

## Hard rules
1. **Authorisation only in services.** Routes never query the DB directly. Every service method takes an `actor` and checks access (04 §4.3). Every new route needs a row in the authorisation matrix test.
2. **The server is authoritative for ordering.** Clients send `{beforeId, afterId}` intents, and the server computes fractional keys. Never use integer positions. Never sort with `localeCompare`.
3. **The placement invariant** (05 §4.1) holds after every transaction. Call `PlacementService.reconcilePlacements` whenever an assignee, parent or deletion changes.
4. **Every list mutation goes through the pipeline** (04 §6.2): tasks, groups, tags and placements use an optimistic reducer from `packages/core`, then the outbox, with `Idempotency-Key` and `X-Rooster-Edit-Time`. Never call `fetch` for these directly from components. Settings, org administration and admin screens are online-only and use plain TanStack Query mutations through `@rooster/api-client`.
5. **Floating dates are strings** (`YYYY-MM-DD`). Never convert a due date to a JS `Date` for comparison. Use the `packages/core/dates` helpers with the user's timezone.
6. **No hard-coded UI strings.** Every string goes in both `en` and `sv`. Swedish must be natural (see the 03 §4 glossary).
7. **No hard-coded design values.** Use Coop semantic tokens and Tailwind theme classes only (03). Every new component gets a kitchen-sink entry at `/_dev/ui`.
8. **Keyboard parity.** Every pointer action has a keyboard path, registered in `keymap.ts`. Shortcut docs are generated from the registry, never duplicated.
9. **No modals** for everyday actions (02 §1). Use inline editing and anchored popovers.
10. **Migrations are append-only.** Never edit a merged migration.
11. **Do not add dependencies** whose purpose overlaps an existing one (see the stack table in 04 §2). Justify each new dependency in the PR.
12. **Tests are part of the work.** Name AC tests `AC-x.y …`. Keep `packages/core` coverage at or above 95 %.

## Reviews
- **Security-relevant code gets an independent review** before it counts as done. That covers auth, sessions, grants, tokens, OAuth/MCP, input handling, uploads, outbound requests (SSRF), shell or process launching, file writes, crypto, email and push, and anything public or unauthenticated. Run both the structured `codex review --commit <sha>` and a focused `codex review "<brief>"` that names the files, the assets and the attacks to try. Re-check after the fixes.
- **Judge every finding, from any reviewer, before acting on it.** Verify that it reproduces in a realistic sequence, then weigh the actual harm:
  - **Fix:** cross-account or credential exposure, privilege escalation, integrity loss.
  - **Weigh against the cost of the fix:** local data loss, degraded UX, a resource limit that can be reached in practice.
  - **Accept:** a finding that needs a trusted component (the operator's S3, IdP or proxy) to misbehave, unless the fix is trivial.
- **Only real problems with meaningful impact get fixed**, each with a regression test that fails without it. Record everything else as "refuted" or "accepted" with the reason, in the ADR or `docs/security/security-review.md`.
- **A reviewer repeating a point is not a reason to reverse an acceptance**; only a new, concrete argument is.
- **When one class of finding keeps recurring, prefer one structural fix**, or an accepted-risk entry, over round after round of patches.

## Conventions
- TypeScript strict and ESM everywhere. Named exports. No default exports, except where a framework requires them (route files).
- Zod schemas live in `packages/core/src/schemas`. Infer types from them (`z.infer`) rather than duplicating them. The server registers them for OpenAPI with `.openapi('Name')`.
- **Sizes are rem** (ADR 0027): the root font size is the UI scale (112.5 % from 1440 px, 125 % from 1600 px). Never hard-code layout px in CSS; JS that sizes layout in px multiplies by `uiScale()` (`src/lib/ui-scale.ts`). Interaction thresholds (offsets, gesture slop) stay px.
- **Tailwind classes = utility + token name** (full mapping at the top of `apps/web/src/styles/theme.css`):
  - colours: `bg-bg-app`, `text-text-muted`, `border-border-strong`, `text-date-overdue`, `bg-tag-red-bg`
  - type: `text-xs` … `text-2xl`, `text-group`
  - spacing: only the 4 px scale from 03 §2.6
  - sizes: `h-row`, `h-control`, `size-hit-touch`
  - radius and shadow: `rounded-sm`, `shadow-md`
  - motion and stacking: `duration-(--dur-fast)`, `z-(--z-toast)`
  - breakpoints: `tablet:`, `desktop:`, `wide:`, `max-tablet:` (phones only), `pointer-coarse:`
  - safe areas and phone chrome: `pt-safe`, `pb-safe`, `px-safe-2`, `h-bottom-nav-safe`, `max-h-sheet`, `bottom-above-nav` (the FAB; not `bottom-fab`, which Tailwind resolves to the `--spacing-fab` size token); sticky list headers use `top-(--list-sticky-top)`

  Tailwind's default palette and scales are **removed**, so off-token classes silently do nothing. Use `cn()` from `src/lib/cn.ts` to merge classes.
- **Tests run in UTC**, as on the CI runners: every vitest project sets `env: { TZ: 'UTC' }` (a new project does too), and `playwright.config.ts` pins the runner, servers and browsers (`timezoneId`). A test about another zone passes it explicitly; never depend on the host zone.
- Kitchen-sink states are forced with `data-force="hover|pressed|focus"`.
- Spec gaps decided during implementation are recorded in `docs/adr/` (e.g. ADR 0001: date formatting details).
- Errors are problem+json with a stable `code`. Throw `AppError(code, status, detail)` from services.
- IDs are UUIDv7 (`packages/core/ids`). Timestamps are ms epoch numbers.
- Files are kebab-case. React components are PascalCase. Hooks are `useX`.
- Comments explain *why*, not *what*. Do not write task-history comments.
- **Release notes have two audiences.** A change users notice gets a CHANGELOG entry (for operators, English) **and** a line under `## Unreleased` in both `docs/guide/en/whats-new.md` and `docs/guide/sv/whats-new.md` (for users: what they see, no operator details, no ADR numbers; ADR 0057). `pnpm release` refuses a release without them.
- Commits and PR titles follow Conventional Commits (`feat(list): …`, `fix(sync): …`).

## Keeping this file current (mandatory)
This file is the entry point for every agent and must describe the repository **as it is now**, not as it was planned. In the same PR as the change, update `AGENTS.md` when you:
- add, rename or remove a top-level directory, app, package or important module (update the **Repository map**);
- add or change a script or command, a required env var, or a dev prerequisite (update **Commands**);
- introduce a convention, rule or pattern that other agents must follow, or retire one (update **Hard rules** / **Conventions**);
- complete a phase (update **Status** below), or record an ADR that changes how agents should work.

Keep the file concise. Put details in `docs/spec/` or `docs/adr/` and link to them. A PR that changes any of the above without updating `AGENTS.md` is not done.

## Status
- **Current phase:** none scheduled. Phase 11 was the last phase in 09; the next work is the backlog (09 §Backlog).
- **Latest release:** 1.5.2 (a new task takes its date while its name is typed, pages open at their top, a pinned settings menu, touch hints), after 1.5.1 (a larger, centred Android icon) and 1.5.0 (Phase 11: the security audit, accessibility, 2,000-task performance, the guide at /help, Admin → System, the storage quota, removed sign-ins, apps without colleagues' emails; ADRs 0052–0056).
- **Last completed phase:** Phase 11, hardening (2026-10-10; released in 1.5.0):
  - the security audit of every trust boundary: 107 findings, 102 fixed, 5 accepted or refuted (`docs/security/security-review.md`, ADR 0056);
  - the ASVS L2 map (`docs/security/asvs.md`); `pnpm audit` and gitleaks in CI;
  - accessibility: axe on every screen, a keyboard-only journey, accessible list names, and a manual screen-reader checklist;
  - 2,000-task performance (chunked rows, keyed row state); server budgets in their own CI step;
  - operations: Admin → System, the storage quota, the backup drill and the release-fixture migration test in CI, the Litestream overlay, a slimmer image;
  - the user guide at `/help` and in `docs/guide/`, the operator guide, CONTRIBUTING, the README with screenshots;
  - the header ⋯ menu with print, and the Behaviour settings;
  - removed sign-ins stay blocked; apps never see colleagues' emails; approvals are bound to the session that showed them.
  - AC-11.1 to AC-11.7. ADRs 0052 to 0056. Migrations `0012` to `0015`.
- **Before that:** Phase 10, recurrence, task reminders, attachments and iCal (2026-10-10; released in 1.4.0):
  - recurring tasks: the RRULE subset in core; the next instance is created on complete or skip, directly below; "this / this and following" on delete;
  - personal task reminders: `!15m` tokens, the picker section, the pane line and the row bell; the claim-then-send job; inbox, push and email;
  - attachments: local or S3, sniffed types, sharp thumbnails, lightbox, paste and drop, blob GC through a trigger;
  - avatar upload, and secret calendar feeds;
  - CLI `--remind`/`--repeat`, TUI and MCP support.
  - AC-10.1, AC-10.2 and AC-10.4 pass in tests. AC-10.3 is verified with ical.js; subscribing from Google Calendar is still a manual check.
  - ADRs 0049 and 0050; migration `0011_p10_reminders_attachments_ical`.
- Phase 9, TUI, MCP and agent access (2026-10-09; released in 1.3.0): the OAuth 2.1 AS on better-auth (CIMD, consent screen with "Allow deleting tasks" and "This session only", audience-bound tokens, refresh reuse revokes the grant), the remote `/mcp` endpoint with scope step-up, discovery documents and the rooster skill, `packages/mcp` with `rooster mcp`/`mcp setup`/`skill`, the full-screen TUI, linked identities and the `admin` capability (`rooster admin reindex`). AC-9.1 to AC-9.6. ADRs 0041 to 0047. Migration `0010_oauth_provider`.
- Phase 8, CLI, grants and API polish (2026-10-09; released in 1.2.0): one grant model for PATs and CLI devices (scopes plus user-chosen org and group constraints, enforced in services, `/api/auth` browser-only), the device flow with a consent page, Settings → Connected apps, the documented OpenAPI with contract tests and e2e response validation, and the `rooster` CLI with release binaries. AC-8.1 to AC-8.5 pass. ADRs 0036 to 0039. Migration `0007_agent_access`.
- Phase 7, notification delivery (2026-10-09; released in 1.2.0): Web Push per device, SMTP email (invites, immediate or batched notifications, the daily digest, confirm-then-POST unsubscribe), the due reminder, and the full preference matrix. AC-7.1 to AC-7.3 pass. ADRs 0033 to 0035. Migration `0006_delivery`.
- Phase 6, collaboration (2026-10-09; released in 1.2.0): assignment, Everyone's tasks, comments and activity, followers, the in-app inbox. AC-6.1 to AC-6.4 pass at the API level and in the e2e suite. ADRs 0028 to 0032. Migration `0005_collab`.
- Phase 5, smart views, search, palette, export and Trash (2026-10-06), released as **v1.0.0**. AC-5.1 to AC-5.3 pass on desktop and the phone projects. ADRs 0012 to 0016 record the decisions; ADR 0016 relaxed the initial-bundle budget to 450 KB.
- **Backlog** (`docs/spec/09-phases.md` §Backlog): the dark theme, the open ASVS gaps, and the Phase 11 follow-ups. Do not build an item unless it is scheduled.
- **E2E:** never run two Playwright suites at once; they share ports 9400, 3181, 5181 and 3182.
- **Git:** commit locally; **do not push to origin unless the maintainer explicitly asks.**
- **Deferred to later phases** (from ADRs 0003–0011; pick them up in the phase named):
  - **Later, unscheduled:** Show the OAuth client's name in activity ("via Claude (MCP)", 11 §2.3; activity shows "via an app" today).
  - **Whenever touched:**
    - `UserService.reorderOrg` should move onto `OrderingService` (ADR 0005).
    - The retention purge job publishes no SSE events (ADR 0009).
  - **Image budget:** 350 MB total and 100 MB for rooster's layers (ADR 0048). Phase 11 is about 249 MB, of which rooster's layers are 40 MB.

## When you finish a WP
- Run every gate in 10 §1.
- PR description: WP ID; the FR, AC and D IDs covered; deviations and ADRs; screenshots (UI); and how you verified it (tests plus a manual check).
