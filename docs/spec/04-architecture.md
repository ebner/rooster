# 04: Architecture

## 1. System context

```
             ┌────────────────────────────── one Docker container ───────────────────────────────┐
 Browser ───►│ Node 24 process                                                                   │
 (SPA/PWA)   │  ┌──────────────┐  ┌─────────────────────────────────────────┐  ┌──────────────┐  │
  ▲  │ SSE   │  │ Static files │  │ Hono app                                │  │ Scheduler    │  │
  │  └──────►│  │ (web build,  │  │  /api/auth/*  better-auth               │  │ (croner)     │  │
  │          │  │  SW, icons)  │  │  /api/v1/*    REST (zod-openapi)        │  │ digests,     │  │
 CLI / TUI ─►│  └──────────────┘  │  /api/v1/events  SSE                    │  │ reminders,   │  │
 MCP (stdio) │                    │  /ical/*      calendar feed             │  │ backups,     │  │
  └─ HTTPS ─►│                    │  /healthz /readyz                       │  │ purges       │  │
             │                    └───────┬───────────────────┬─────────────┘  └──────┬───────┘  │
             │                     services (domain + authz)   in-process EventBus ◄───┘          │
             │                            │                                                      │
             │                     Drizzle ─► better-sqlite3 ─► /data/rooster.db (WAL)           │
             │                     BlobStore ─► /data/attachments | S3                           │
             └───────────────────────────────────────────────────────────────────────────────────┘
   Reverse proxy (operator's: Caddy, Traefik or nginx) terminates TLS → container :3000
   Outbound: OIDC issuers, SMTP (optional), Web Push services, S3 (optional)
```

Single process, single node. The web app is served from the **same origin** as the API, so CORS is never needed and cookies are `SameSite=Lax`.

## 2. Stack (pinned majors; researched 2026-10-04, use the latest patch)

| Concern | Choice | Notes / alternatives rejected |
|---|---|---|
| Runtime | **Node.js 24 LTS** | Bun and Deno rejected (native addon and distroless risk). |
| Language | **TypeScript 7** (strict) | `"strict": true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. |
| Package manager | **pnpm 12** workspaces + catalogs | No Turborepo initially. |
| Lint / format | **Biome 2** | One tool. ESLint and Prettier are not used. |
| HTTP | **Hono 4** + `@hono/node-server` | `app.request()` for tests; built-in `streamSSE`. |
| Validation / OpenAPI | **Zod 4** + `@hono/zod-openapi` + Scalar API reference | Schemas live in `packages/core/schemas` and are shared by all clients. |
| DB | **SQLite** via **better-sqlite3 13** | Hidden behind Drizzle; `node:sqlite` is a future swap. |
| ORM / migrations | **Drizzle ORM 0.45 + drizzle-kit** | SQL migrations committed and applied at boot. Pin 0.45 until 1.0 is GA. |
| Auth | **better-auth 1.7** | Plugins: `genericOAuth`, `deviceAuthorization`, `bearer`, `@better-auth/api-key`. Drizzle adapter. Orgs are rooster-owned tables (ADR 0002). |
| Web framework | **React 19** + **Vite 8** | |
| Routing | **TanStack Router** (file-based, typed search params) | |
| Server state | **TanStack Query 5** + IndexedDB persister (`idb-keyval`) | A custom outbox is layered on top (§6). Watch TanStack DB for the future. |
| UI state | **Zustand 5** | Selection, mode, undo stack, drafts, pane. |
| Styling | **Tailwind CSS 4** mapped to Coop tokens | `cva` for variants. |
| A11y primitives | **React Aria Components** | Popover, Menu, ListBox, Dialog, Calendar, Toast. |
| Drag and drop | **dnd-kit** (`@dnd-kit/core` 6 + `@dnd-kit/sortable` 10) | Wrapped in `useListDnd()`. Pragmatic DnD rejected (no keyboard drag). |
| Ordering | **fractional-indexing 4** (rocicorp) | Base-62 TEXT keys. |
| Rich text | **Tiptap 3** + `@tiptap/markdown` | Markdown is the storage format; round-trip tests are mandatory. Fallback: Milkdown. |
| Markdown render (read-only) | `react-markdown` + `remark-gfm`, **no raw HTML** | Comments, previews. |
| Dates | **date-fns 4** + `@date-fns/tz` | Floating dates are `YYYY-MM-DD` strings and are never `Date` objects. |
| i18n | **i18next** + `react-i18next` + `i18next-icu` | Catalogs in `packages/i18n`, shared by web, server emails and the CLI. |
| PWA | **vite-plugin-pwa** (Workbox) | `injectManifest` strategy (a custom SW is needed for push). |
| Icons | **lucide-react** | |
| Server logging | **pino** (JSON) | Request ID per request. |
| Scheduler | **croner** | In-process cron. |
| Email | **nodemailer** + **react-email** templates | |
| Web Push | **web-push** | VAPID keys auto-generated at first boot. |
| Images | **sharp** | Thumbnails. |
| S3 | `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` | Optional. |
| CLI | **citty** + **@clack/prompts**, built with **tsdown** | Binaries via `bun build --compile`. |
| TUI | **Ink 8** (React for terminals) | Shares hooks and logic with the web where sensible. |
| MCP | `@modelcontextprotocol/sdk` | stdio transport. |
| Keychain | `@napi-rs/keyring` | Falls back to a 0600 file. |
| API client | **openapi-typescript** + **openapi-fetch** (`packages/api-client`) | Generated from the server's OpenAPI document. CI fails if it is stale. |
| Testing | **Vitest 5**, **Playwright**, `@axe-core/playwright` | |

## 3. Repository layout

```
rooster/
├─ AGENTS.md                 # rules for implementing agents (CLAUDE.md imports it)
├─ README.md
├─ docs/spec/                # this specification
├─ docs/adr/                 # ADRs for decisions made during implementation
├─ apps/
│  ├─ server/                # Hono API, better-auth, jobs, serves web build
│  │  ├─ src/
│  │  │  ├─ main.ts          # boot: config → db → migrate → app → listen → scheduler
│  │  │  ├─ config.ts        # zod-validated env
│  │  │  ├─ app.ts           # createApp(deps) – pure factory, used by tests
│  │  │  ├─ auth/            # better-auth instance, hooks (allowlist, personal org)
│  │  │  ├─ db/              # drizzle schema (*.ts), client, pragmas, migrations/
│  │  │  ├─ routes/          # one file per resource; zod-openapi route defs
│  │  │  ├─ services/        # domain services (authz enforced here)
│  │  │  ├─ events/          # EventBus, SSE hub
│  │  │  ├─ jobs/            # scheduler + job handlers
│  │  │  ├─ blob/            # BlobStore: local | s3
│  │  │  ├─ mail/ push/ ical/ search/
│  │  │  └─ lib/             # errors (problem+json), ids, clock, logger
│  │  └─ test/
│  ├─ web/                   # React SPA + PWA
│  │  ├─ src/
│  │  │  ├─ routes/          # TanStack Router file routes
│  │  │  ├─ features/        # list/, pane/, groups/, dates/, palette/, settings/, auth/, notifications/
│  │  │  ├─ ui/              # Coop components (03)
│  │  │  ├─ data/            # query keys, fetchers, mutations, outbox, sync, sse
│  │  │  ├─ state/           # zustand stores (selection, mode, undo, drafts)
│  │  │  ├─ keymap.ts        # single keymap registry (02 §6)
│  │  │  ├─ sw.ts            # service worker (injectManifest)
│  │  │  └─ styles/
│  │  └─ e2e/                # Playwright
│  └─ cli/                   # rooster CLI + TUI + MCP
│     └─ src/{commands/, tui/, mcp/, auth/, config/, format/}
├─ packages/
│  ├─ core/                  # PURE TS, no IO: schemas (zod), DTO types, dates (parse/format/dueState),
│  │                         # recurrence, ordering helpers, permissions predicates, optimistic reducers
│  ├─ api-client/            # generated OpenAPI types + typed fetch client (web, cli)
│  ├─ i18n/                  # locales/en/*.json, locales/sv/*.json, init helpers
│  └─ tokens/                # Coop tokens: tokens.css + index.ts
├─ docker/                   # Dockerfile, entrypoint, healthcheck.js, compose examples, proxy snippets
├─ biome.json  pnpm-workspace.yaml  tsconfig.base.json  package.json
```

**Dependency rule:** `apps/*` may depend on `packages/*`. `packages/core` depends only on zod, date-fns and fractional-indexing. `packages/*` never depend on `apps/*`. The web app never imports server code, and vice versa.

## 4. Server design

### 4.1 Layers

1. **Routes** (`routes/*.ts`): declare the OpenAPI route (zod request and response schemas), parse the input, resolve the **actor** (user ID plus auth method plus scopes), call **one** service method, and map the result to a DTO.
2. **Services** (`services/*.ts`): all business rules and **all authorisation checks**. Each public method takes `(actor, input)` and runs inside a DB transaction (`db.transaction(..., { behavior: 'immediate' })`). It emits domain events to the EventBus *after* the commit.
3. **Data**: Drizzle queries. There are no repositories beyond thin query helpers. Raw SQL is allowed for FTS and ordering edge cases.

### 4.2 Core services

| Service | Responsibilities |
|---|---|
| `OrgService` | Orgs, members, invites, personal org bootstrap, the user's org order. |
| `GroupService` | CRUD and ordering of groups. Inbox invariants. Delete with move or delete of tasks. Split at cursor. |
| `TaskService` | Create, patch (per-field LWW), complete (and trigger recurrence), delete and restore, duplicate, bulk. |
| `PlacementService` | `reconcilePlacements(taskIds)`, which enforces the placement invariant (05 §4), plus `move()`. |
| `OrderingService` | Computes fractional keys from `{beforeId, afterId}` intents within a transaction, and rebalances when a key exceeds 64 characters. |
| `TagService` | Tags, task-tag add and remove, merge. |
| `CommentService`, `ActivityService`, `FollowerService` | Collaboration (P6). |
| `NotificationService` | Fan-out of domain events into notifications, push and email per preferences (P6/P7). |
| `RecurrenceService` | Computes the next date and creates the next instance (P10). |
| `SearchService` | FTS5 queries with access filtering. |
| `AttachmentService` | Upload, thumbnail, download authorisation (P10). |
| `AdminService` | Allowlist, users, backups. |

### 4.3 Authorisation model

- **Actor:** `{ userId, via: 'session' | 'bearer' | 'pat' | 'oauth', grant: Grant | null }`. The browser session has no grant (full access). PATs, CLI devices and OAuth tokens carry a grant: capabilities (scopes) plus user-chosen org and group constraints (11 §2). A missing capability gets `403 forbidden_scope`, and a target outside the constraints gets `403 outside_grant` (unreadable targets stay `404`). The checks live in services (`authorizeGrant`, 11 §2.3).
- **Non-members always get `404 not_found`, never `403`**, for any org-scoped resource, so that existence never leaks. `403` is used only for authenticated members lacking a role (owner-only actions) or a scope (read-only PAT).
- **Org access:** `requireMember(actor, orgId)` → the role. All task, group, tag and comment access resolves the entity's `org_id` first, then calls `requireMember`. **Never trust an `orgId` from the client** for an entity that already has one.
- **Groups** are additionally owned: `group.user_id === actor.userId`, otherwise 404 (not 403, to avoid leaking existence).
- **Personal org:** only its owner is a member, so membership checks are sufficient. Invites and member changes to a personal org are rejected (`409 personal_org`).
- **Owner-only:** org settings, members, invites, org deletion.
- **Comment edit and delete:** the author only.
- **Instance admin:** `ROOSTER_ADMIN_EMAILS` includes the actor's verified email.
- Authorisation is covered by a **table-driven test matrix** (10 §3) of every route against {non-member, member, owner, other-user-in-org-for-groups, read-only PAT}.

### 4.4 Auth (better-auth) configuration

- **Base path** `/api/auth`. `secret` = `ROOSTER_AUTH_SECRET`. `baseURL` = `ROOSTER_BASE_URL`. `trustedOrigins` = [`ROOSTER_BASE_URL`].
- **Providers:**
  - Built-in `google` when `ROOSTER_GOOGLE_CLIENT_ID` and `ROOSTER_GOOGLE_CLIENT_SECRET` are set.
  - `genericOAuth` providers from `ROOSTER_OIDC_PROVIDERS` (a JSON array of `{id, name, discoveryUrl, clientId, clientSecret, scopes?}`), with PKCE on.
  - The login page renders one button per configured provider, using the `name` and an optional icon.
- **Account linking:** enabled for trusted providers when the email is verified (FR-AUTH-5).
- **Allowlist hook:** in `databaseHooks.user.create.before` *and* on sign-in for existing users, via `hooks.before` on callback routes. Sign-in is allowed only if `email_verified` and one of these holds:
  1. The email is in `ROOSTER_ALLOWED_EMAILS` or `allowlist_entry`.
  2. The email domain is in `ROOSTER_ALLOWED_DOMAINS` or `allowlist_entry`.
  3. There is a pending, unexpired email invitation for the email.
  4. The user is an admin email.
  5. A valid, unrevoked, unexpired **invite link** is carried through the OAuth flow:
     - `GET /invite/:token` (the web page) sets a short-lived (15 min), signed, httpOnly cookie `rooster.invite` before starting the sign-in.
     - The hook validates it against `invite_link`.
     - After user creation, the membership is created and `uses` is incremented. A single-use link is then exhausted.
  6. The user already exists and is a member of at least one live shared org (ADR 0003).

  Otherwise the user is redirected to `/not-invited`. If none of the allowlist sources are configured, **only** admin emails can sign in (safe default).
- **Personal org bootstrap:** `databaseHooks.user.create.after` creates the personal org, the owner membership, the Inbox and the default groups (localised from `Accept-Language`) in one transaction.
- **Sessions:** cookie `rooster.session`, httpOnly, Secure (when the base URL is https), SameSite=Lax, 30-day expiry with a 1-day update age. **`cookieCache` is disabled**, so that revoking a session or disabling a user takes effect on the very next request (AC-1.7). A session lookup is one indexed SQLite read, which is negligible.
- **CLI:**
  - The `deviceAuthorization` plugin uses client ID `rooster-cli`. Codes expire after 10 minutes, with a 5 s poll interval.
  - The web app has a `/device` page that requires login, shows the code and the client name, and offers Approve or Deny.
  - The resulting session token is used as `Authorization: Bearer` through the `bearer` plugin.
- **OAuth 2.1 authorization server (P9):** better-auth's OAuth 2.1 Provider with Client ID Metadata Documents, rooster's own consent screen and grants, opaque audience-bound access tokens for `/mcp` and `/api/v1` (11 §4).
- **PATs:** `@better-auth/api-key`, with the prefix `rooster_pat_` and metadata `{grantId, name}` (the grant holds the scopes and constraints, 11 §2). They are accepted as `Authorization: Bearer rooster_pat_…`. A small middleware tells a PAT from a session token by its prefix and verifies it through the api-key plugin.
- Rate limiting: better-auth's built-in limiter on `/api/auth/*` (memory storage).

### 4.5 Domain events & realtime

- `EventBus` is an in-process typed emitter. Services emit events after commit:
  - `task.created`, `task.updated` (with changed fields), `task.moved`, `task.completed`, `task.deleted`
  - `group.*`
  - `tag.*`
  - `comment.*`
  - `member.*`
  - `notification.created`
- **SSE hub** (`GET /api/v1/events`):
  - One stream per client connection, authenticated by cookie or bearer.
  - Subscribes to all orgs the user belongs to, and is re-evaluated on `member.*` events.
  - Message format:
    ```
    event: invalidate
    id: <monotonic server seq>
    data: {"org":"<orgId>","keys":[["my-list","<orgId>"],["task","<taskId>"]],"origin":"<clientId>"}
    ```
  - Other event types: `notification` (badge count plus a preview) and `hello` (server version, for update detection).
  - A heartbeat comment `: ping` every 25 s.
  - On reconnect the client refetches every active query. There is no replay log: lists are small.
  - Clients send the header `X-Rooster-Client-Id` on mutations. The hub includes `origin`, so the originating tab skips redundant refetches.
  - Invalidation targets the **affected users only**. For example, `my-list` keys go to the task's assignee and to any user whose placement or parent view changed. `task:<id>` and `everyone:<org>` go to all org members.

### 4.6 Jobs (croner, in-process)

| Job | Schedule | Phase |
|---|---|---|
| Purge trash (> 30 days) and expired idempotency keys (> 7 days) | daily 03:30 | 2 (WP 2.1) |
| Backup: `VACUUM INTO /data/backups/rooster-<ts>.db`, keeping 7 daily and 4 weekly | daily `ROOSTER_BACKUP_CRON` (default 03:00) | 2 (WP 2.9) |
| `PRAGMA optimize` | daily 04:00 | 0 |
| Due reminders (push) | every minute; sends to users whose local reminder time = now | 7 |
| Email digest | every minute, matching each user's local digest time | 7 |
| Email notification batching | every 5 minutes | 7 |

Jobs must be **idempotent**: each one records a `job_run` row keyed by job, user and local date, to avoid double sends after a restart.

### 4.7 Search
- An FTS5 table `task_fts(task_id UNINDEXED, org_id UNINDEXED, title, description, comments)` uses tokenizer `unicode61 remove_diacritics 2` and `prefix='2 3 4'`. It is maintained by `SearchService` in the same transaction as task and comment writes (see 05).
- A query is tokenised by the server and each term becomes a prefix match (`term*`). The results are joined to `task` and filtered by membership of the actor's orgs and by `deleted_at IS NULL`, then ranked with `bm25()`. Limit 50.

### 4.8 Blob storage
The interface is `BlobStore { put(key, stream, meta), get(key) → stream, delete(key), signedUrl?(key, ttl) }`.
- **Local:** `/data/attachments/<orgId>/<attachmentId>`.
- **S3:** the same key scheme in the configured bucket.
- Downloads go through `GET /api/v1/attachments/:id` (authorisation check). The handler then streams the local file, or redirects to a 60 s presigned URL on S3.
- Uploads are streamed with a size limit, the MIME type is sniffed with `file-type`, and `Content-Type` comes from the sniffed type. Images get a WebP thumbnail made by sharp.

### 4.9 Configuration
All config comes from env vars, validated by a zod schema at boot. On a validation error the process logs every problem and exits with code 78 (EX_CONFIG). The full table is in 08 §3.

### 4.10 Errors
- Responses use RFC 9457 `application/problem+json`: `{type, title, status, detail, code, errors?}`.
- `code` is a stable machine string, for example `not_found`, `validation_failed`, `personal_org`, `conflict_deleted`, `forbidden_scope`, `outside_grant`, `rate_limited`.
- The server never leaks stack traces. 5xx errors are logged with the request ID, which is returned in the `X-Request-Id` header.

### 4.11 Security baseline
- Hono `secureHeaders`:
  - The CSP is strict: `default-src 'self'; img-src 'self' data: blob: https:` (for OIDC avatars); `connect-src 'self'`; `style-src 'self' 'unsafe-inline'` (React Aria positioning); `frame-ancestors 'none'`; `form-action 'self'` plus the OIDC issuers.
  - `Referrer-Policy: same-origin` and `Permissions-Policy` minimal.
- **CSRF:**
  - Cookie-authenticated unsafe methods require `Origin` to be equal to `ROOSTER_BASE_URL`. JSON-only bodies are accepted (`Content-Type: application/json` or multipart for uploads).
  - Bearer-authenticated requests are exempt.
- **Input:** zod everywhere. Titles and names are trimmed and control characters stripped. Markdown is stored raw and rendered **without raw HTML**. Links get `rel="noopener noreferrer nofollow"`.
- **Secrets:** PATs, device codes and iCal tokens are stored hashed (SHA-256), compared in constant time, and displayed once.
- **Dependencies:** `pnpm audit` runs in CI. Renovate or Dependabot config is recommended.
- **Trusted proxy:** `ROOSTER_TRUST_PROXY=true` makes the server honour `X-Forwarded-*` for the client IP (rate limits, logs) and protocol.

## 5. Web client design

### 5.1 Data model on the client
Query keys (all scoped by org):

| Key | Payload | Source |
|---|---|---|
| `['me']` | user, settings, orgs (ordered), roles | `GET /me` |
| `['my-list', orgId]` | `{groups[], tasks[]}` — every task assigned to me in the org (open, plus completed in the last 14 days), each with its placement (`groupId`, `position`), plus **all subtasks** of those tasks (any assignee) and the parents of my orphan subtasks (for breadcrumbs) | `GET /orgs/:id/my-list` |
| `['tags', orgId]` | tags | `GET /orgs/:id/tags` |
| `['task', taskId]` | full task: description, subtasks, followers, attachments | `GET /tasks/:id` |
| `['activity', taskId]` | paged activity and comments | `GET /tasks/:id/activity` |
| `['everyone', orgId, filters]` | grouped open tasks | `GET /orgs/:id/tasks?view=everyone` |
| `['notifications']` | paged | `GET /notifications` |

- **Smart views are derived client-side** from `['my-list', orgId]` by pure selectors in `packages/core/views.ts`, so they work offline and update instantly.
- The CLI uses the server-side equivalent (`?view=today`), which shares the same selector code from `packages/core`.

### 5.2 UI state (Zustand)
- `listStore`: mode (navigate/edit), selected IDs, anchor, editing ID, draft rows, expanded parents (mirrored to the server), "show completed".
- `paneStore`: open, taskId, full-screen, width.
- `undoStore`: a stack of `{label, inverseOps[], redoOps[]}`.
- `syncStore`: online, outbox count, last error, SSE state.

### 5.3 Keymap
`keymap.ts` registers `{id, keys, when: 'global'|'navigate'|'edit'|'pane', action, labelKey}`. A single `useKeymap()` listener on `document` dispatches the actions, handles **Tab chords** (inside the list, Tab `keydown` is always prevented, and native focus movement is emulated when Tab is released without a chord; ADR 0006) and **G-sequences** (1 s timeout). The cheat sheet and the palette actions are generated from the registry.

### 5.4 Rendering & performance
- The list renders flat rows (group header, task, subtask, add row) from a memoised selector.
- No virtualisation up to 1,000 visible rows. If profiling shows a need, use `@tanstack/react-virtual` and keep the dragged item mounted.
- Rows are `memo` components keyed by ID with stable callbacks.
- Text inputs are uncontrolled while editing and commit on events, to avoid a re-render per keystroke across the list.

## 6. Offline & sync (D-32)

### 6.1 Reads
- `persistQueryClient` uses an IndexedDB persister (`idb-keyval`, key `rooster-cache-v1:<userId>`, one per account, ADR 0056), max age 30 days, throttled to 1 s. Persisted queries: `me`, `my-list`, `tags`, `task` (the 200 most recently used), and `notifications` (first page).
- `navigator.storage.persist()` is requested after login.
- On app start the cache renders immediately (stale-while-revalidate) and then refetches when online.

### 6.2 Writes: the mutation pipeline

```
UI action ─► op = {opId: uuidv7, kind, entityId, payload, editTime: Date.now(), clientId}
          ─► applyOptimistic(op) on Query cache (pure reducer from packages/core/reducers)
          ─► outbox.enqueue(op)  (IndexedDB store "outbox", FIFO)
          ─► flusher (leader tab only) sends ops sequentially:
                 HTTP request with headers
                   Idempotency-Key: opId
                   X-Rooster-Edit-Time: editTime
                   X-Rooster-Client-Id: clientId
               2xx  → remove from outbox; merge server response into cache (server is authoritative)
               403/404/409/410/422 → remove; revert via refetch of affected keys; toast with reason
               401  → pause flusher; show "Session expired – sign in" (ops kept)
               429  → keep; wait for Retry-After, then resume
               5xx/network → keep; exponential backoff 1 s → 30 s
```

- **Leader election:** the Web Locks API (`navigator.locks.request('rooster-outbox', …)`) ensures exactly one tab flushes. Tabs share outbox state through `BroadcastChannel('rooster')`.
- **Flush triggers:** enqueue, `online`, `visibilitychange` → visible, SSE (re)connect, the 30 s timer, and pull-to-refresh. There is no reliance on Background Sync, which iOS lacks.
- **Ordering:** ops are FIFO per client. An op that references a client-created entity (for example a task patch after a create) works because the create precedes it in the queue and IDs are client-generated.
- **Idempotency:** the server stores `(opId, userId) → status + full response body` for 7 days. Replays return the stored status and body.
- **Per-field last-write-wins:**
  - Every LWW-able entity stores `field_clock` (a JSON map field → ms epoch).
  - On patch, the server applies a field only if `editTime ≥ field_clock[field]`, then sets `field_clock[field] = editTime`.
  - `editTime` is clamped to `[serverNow - 30 days, serverNow + 5 s]`, so that a client clock skew can't win forever.
  - Fields that are not applied are reported back in `ignoredFields`, so the client can refetch.
- **Placement moves** use the clock key `pos:<userId>` (group plus position together). **Completion** uses `completed`. **Dates** (due, time, start, recurrence) share the single key `due` (05 §4.4).
- **Set-like fields** (tags) use add and remove ops (not set replacement), so concurrent tag changes merge.
- **Undo** pushes inverse ops through the same pipeline.

### 6.3 Service worker
- `injectManifest` with a custom `sw.ts`:
  - Precache the app shell, fonts and icons.
  - `NavigationRoute` → `index.html` (except `/api/*` and `/ical/*`).
  - **Never cache `/api/*`.**
  - Handle `push` and `notificationclick`, which focuses or opens `/o/:org/t/:id`.
- **Update:** register with `registerType: 'prompt'`. When a new SW is waiting, show a toast (FR-PWA-6). `skipWaiting` happens only when the user clicks Reload **and** the outbox is empty, or after the outbox is flushed.
- **Version handshake:** the SSE `hello` event carries the server version. If it is newer than the client bundle, the client checks for an update.

## 7. Ordering (D-35)

- `position` is TEXT, using fractional-indexing base-62 keys. The order is `ORDER BY position, id` with SQLite BINARY collation. **Never** use NOCASE or `localeCompare`.
- **The client sends intent:** `{beforeId?, afterId?}`, the neighbours at the drop location in the *server's* ordering domain (the same group for placements, the same parent for subtasks, the same user and org for groups).
- **The server** loads the neighbours' keys in the transaction and computes `generateKeyBetween(after.position, before.position)`.
  - If a neighbour is not found or is not in the expected domain (stale client), it falls back to the end of the group, and the response tells the client the actual position.
  - If a key would collide with an existing equal key, it regenerates between the actual neighbours.
- **The client** computes the same key optimistically for instant display. The server value replaces it on response.
- **Rebalance:** when a generated key exceeds 64 characters, the whole domain is re-keyed with `generateNKeysBetween(null, null, n)` in the same transaction, and an `invalidate` event is emitted.
- Domains:
  - `placement(user_id, org_id, group_id)`
  - `task_group(user_id, org_id)` (Inbox fixed at the top, excluded)
  - `task(parent_id)` for subtasks (`subtask_position`)
  - `org_member_pref(user_id)` for the sidebar org order

## 8. Internationalisation & time

- **UI language:** `user.locale` (`en` or `sv`), defaulting to `navigator.language`. The CLI uses `$LANG` or the config. Emails use the recipient's locale.
- **Formatting:** `Intl.DateTimeFormat` and `Intl.NumberFormat` with the user's locale, plus the date-format override (`MMM d` vs `d MMM`).
- **Floating dates:** `due_date` and `start_date` are `YYYY-MM-DD` and are compared as strings against "today" computed in the **viewer's timezone**. A task due 2026-10-10 is "today" for every viewer on their own 10 October.
- **Timed dues:** `due_time` is `HH:MM` and `due_tz` is IANA (the creator's timezone at the time it was set). Overdue checks and reminders compute the instant with `@date-fns/tz`. Display converts to the viewer's timezone if it differs, and shows the original timezone in the tooltip.
- **"Today"** is computed per user. Server jobs iterate users by their timezone.

## 9. Observability & operations hooks
- Logs: pino JSON to stdout, level from `ROOSTER_LOG_LEVEL`, with request logs `{reqId, method, path, status, ms, userId}`.
- `/healthz` (process up) and `/readyz` (DB `SELECT 1` plus migrations applied).
- An optional `/metrics` endpoint (Prometheus text) when `ROOSTER_METRICS_TOKEN` is set, protected by bearer. It reports request counts and latencies, SSE connections, outbox replays, job runs and the DB size.
- The server version comes from `package.json` plus the git SHA (build arg). It is exposed in `/api/v1/meta` and in the SSE `hello` event.
