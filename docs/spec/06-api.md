# 06: REST API v1

- **Base:** `/api/v1`. JSON only (UTF-8). Every route is declared with `@hono/zod-openapi`.
- The spec is served at `/api/v1/openapi.json`, with interactive docs at `/api/docs` (Scalar).
- `packages/api-client` is generated from that spec (`pnpm gen:api`). CI fails when the generated client is stale.

## 1. Conventions

| Topic | Rule |
|---|---|
| Auth | One of: session cookie (web); `Authorization: Bearer <session token>` (CLI device flow); `Authorization: Bearer rooster_pat_…` (PAT). An unauthenticated request gets `401 {code:"unauthenticated"}`. |
| Scopes | Non-browser credentials carry a grant (11 §2): capabilities (`tasks:read`, `tasks:write`, `comments:write`, `tasks:assign`, `groups:write`, `tasks:delete`, `notifications:read`) plus user-chosen org and group constraints. A missing capability gets `403 forbidden_scope`, and a target outside the constraints `403 outside_grant`. Settings, org administration and admin routes need the browser session. |
| CSRF | For cookie auth on POST, PATCH, PUT and DELETE, the `Origin` header must equal `ROOSTER_BASE_URL`. |
| Idempotency | Every mutation accepts `Idempotency-Key: <uuid>`. The web outbox always sends it. Replays within 7 days return the original status and body. |
| LWW | Mutations accept `X-Rooster-Edit-Time: <ms epoch>`, the time the user made the edit, and default to the server's now. Fields older than the stored clock are skipped and listed in `ignoredFields`. |
| Client ID | `X-Rooster-Client-Id: <uuid>` (per tab/install) is echoed in SSE `origin`. `X-Rooster-Client: web\|pwa\|cli\|tui\|mcp/<version>` is recorded as `via` in activity entries. |
| IDs | The client may supply `id` (UUIDv7) on create. If omitted, the server generates one. A duplicate `id` with different content gets `409 id_conflict`. |
| Errors | RFC 9457 problem+json, with a stable `code` (see 04 §4.10). `422 validation_failed` includes `errors: [{path, message}]`. |
| Pagination | Cursor based: `?limit=50&cursor=<opaque>` → `{items, nextCursor}`. |
| Time | Timestamps are ms epoch numbers. Dates are `YYYY-MM-DD`. Times are `HH:MM`. |
| Ordering intents | `afterId` is the item that will be **directly above** the moved or created item (lower position key). `beforeId` is the item **directly below** it (higher key). Both null means "end of the domain"; only `afterId` null means "top". Both IDs must belong to the same ordering domain (04 §7); otherwise the server falls back to the end and returns the actual position. |
| Org IDs | `:orgId` accepts an org ID, a slug, or the alias `personal` (05 §2). |
| Non-members | Always `404` for org-scoped resources (04 §4.3). |
| Versioning | Breaking changes require `/api/v2`. Additive changes are allowed in v1. |
| Rate limit | 600 req/min per user for the API and 30/min for auth endpoints. Exceeding them gets `429 rate_limited` with a `Retry-After` header. |

## 2. Endpoints

### 2.1 Meta & session
| Method & path | Description | P |
|---|---|---|
| GET `/healthz`, `/readyz` | Liveness and readiness (no auth, outside `/api/v1`). | 0 |
| GET `/api/v1/meta` | `{version, gitSha, providers:[{id,name}], features:{email,push,s3}}`. No auth; used by the login page and the CLI. | 0 |
| GET `/me` | User, settings, ordered orgs with roles, and `isAdmin`. | 1 |
| PATCH `/me` | Name, locale, timezone, weekStart, dateFormat, timeFormat, prefs (partial). | 1 |
| PUT `/me/org-order` | `{orgId, beforeId?, afterId?}` (sidebar order). | 1 |
| PATCH `/me/orgs/:orgId` | `{collapsed}`: the sidebar section collapse state (`org_member_pref`). | 1 |
| PUT `/me/avatar` · DELETE `/me/avatar` | multipart `file` (image, ≤ 2 MB). It is resized to 256 px WebP, stored at BlobStore key `avatars/<userId>`, and sets `user.image` to `/api/v1/avatars/<userId>?v=<ts>`. DELETE reverts to the OIDC picture. | 10 |
| GET `/avatars/:userId` | Serves an avatar to any user sharing an org with that user. | 10 |
| GET `/me/sessions` · DELETE `/me/sessions/:id` | List and revoke sessions. | 1 |
| GET `/me/grants` · PATCH `/me/grants/:id` · DELETE `/me/grants/:id` | Connected apps (11 §3.2): every PAT, CLI device and OAuth client grant. PATCH edits `{label?, scopes?, constraints?, expiresAt?}` (narrowing an OAuth client's scopes is allowed, widening is not). DELETE revokes. PATCH needs the browser session. A PAT or device may list grants and revoke **its own** (`rooster logout`, `apps ls`). | 8/9 |
| POST `/me/tokens` | A PAT `{name, scopes, constraints, expiresInDays?}` → `{token, grant}` (the token is shown once). From the browser, or from a CLI device session for a subset of its own grant (`422 widening_not_allowed` otherwise); never from a PAT. | 8 |
| `/api/auth/*` | better-auth: sign-in/social, oauth2 callbacks, sign-out, and the device flow's `/device/code` and `/device/token`. **Browser cookie only**: any `Authorization` or API-key credential gets `403`, except on the two device endpoints, which the CLI calls before it has a session (ADR 0037). Device review, approve and deny are rooster routes: `GET /device/:userCode`, `POST /device/:userCode/approve`, `POST /device/:userCode/deny`. | 1/8 |

### 2.2 Orgs, members, invites
| Method & path | Description | P |
|---|---|---|
| GET `/orgs` | Orgs of the actor (ordered). | 1 |
| POST `/orgs` | `{name, slug?, avatarEmoji?, color?}`. Creates the org, the owner membership, the actor's Inbox and the default groups. | 1 |
| PATCH `/orgs/:orgId` | Owner only. Personal org: only `avatarEmoji` and `color` can change. | 1 |
| DELETE `/orgs/:orgId` | Owner only. Body `{confirmName}`. Not allowed for the personal org. | 1 |
| GET `/orgs/:orgId/members` | `[{userId, name, email, image, role}]`. | 1 |
| PATCH `/orgs/:orgId/members/:userId` | `{role}`, owner only. The last-owner rule applies. | 1 |
| DELETE `/orgs/:orgId/members/:userId` | Owner, or self (leave). Runs the member-removal invariant. | 1 |
| GET/POST `/orgs/:orgId/invites` | With `{email, role, expiresInDays?}`: an email invite (better-auth `invitation`). From P7 it also sends an email when SMTP is configured; until then, and whenever SMTP is absent, the response's `url` is shown for copying. With `{role, multiUse?, expiresInDays?}` and no email: a **link invite** (`invite_link`). Both return `{id, kind, url}`, where the URL is `${BASE_URL}/invite/<token>`. | 1 |
| DELETE `/orgs/:orgId/invites/:id` | Revoke either kind. | 1 |
| GET `/invites/:token` | Preview (org name, inviter and validity). **No auth required**. Used by the `/invite/:token` web page, which then sets the `rooster.invite` cookie and starts sign-in (04 §4.4). | 1 |
| POST `/invites/:token/accept` | For an already signed-in user: join, creating the Inbox and default groups for the new member. Sign-in through an invite link accepts automatically. | 1 |

### 2.3 My list, views and groups
| Method & path | Description | P |
|---|---|---|
| GET `/orgs/:orgId/my-list?completedSince=<ms>` | `MyListDTO` (05 §5). By default, completed tasks from the last 14 days are included. | 2 |
| POST `/orgs/:orgId/groups` | `{id?, name, beforeId?, afterId?, splitAfterTaskId?}` → GroupDTO (plus moved placements when splitting). | 2 |
| PATCH `/groups/:id` | `{name?, collapsed?}`. | 2 |
| POST `/groups/:id/move` | `{beforeId?, afterId?}` → `{position}`. | 2 |
| DELETE `/groups/:id` | `{moveTasksTo: groupId}` or `{deleteTasks: true}`. An empty group needs neither. → 204. | 2 |
| POST `/groups/:id/restore` | Undo a delete (restores the tasks deleted alongside it). | 2 |
| PUT `/tasks/:id/expanded` · DELETE `/tasks/:id/expanded` | Persist the per-user expansion of a parent row. | 3 |
| GET `/orgs/:orgId/tasks` | **General query** for CLI, MCP and Everyone. Query params: `view=my\|today\|week\|overdue\|nodate\|everyone`, `assignee=me\|<userId>\|none\|any` (repeatable, OR-combined), `hasDue=true\|false`, `groupId`, `tag` (repeatable), `dueFrom`, `dueTo`, `completed=false\|true\|any`, `parentId`, `q`, `limit`, `cursor`, `include=description,subtasks`. | 2/6 |

### 2.4 Tasks
| Method & path | Description | P |
|---|---|---|
| POST `/orgs/:orgId/tasks` | Create. Body: `{id?, title, description?, dueDate?, dueTime?, dueTz?, startDate?, assigneeId? (default: me), parentId?, groupId?, beforeId?, afterId?, tagIds?, tagNames?, parse?: boolean}`. With `parse:true` the server runs the NL parser on the title (`#tags`, `@member`, `>Group`, dates) using the actor's locale, timezone and week start. The CLI and MCP use this; the web parses client-side and sends structured fields. → `201 TaskDTO`. | 2 |
| GET `/tasks/resolve?ref=&org=&deleted=` | P8. Resolves a CLI/MCP task ref (07 §3): `42` (seq, with `org`), `acme#42`, or a UUID prefix of at least 8 hex characters across the actor's orgs. → `TaskDTO`; `404` when not found or not readable; `409 ambiguous_ref` with `candidates` (≤ 10). `deleted=true` also matches Trash. | 8 |
| GET `/tasks/:id` | Full task: `TaskDTO & {description, subtasks: TaskDTO[], tags, followers (P6), attachments (P10), parentChain: [{id,title}]}`. | 3 |
| PATCH `/tasks/:id` | Partial: `{title?, description?, dueDate?, dueTime?, dueTz?, startDate?, assigneeId?, parentId?, recurrence?, recurrenceBasis?}` → `{task, ignoredFields}`. | 2 |
| POST `/tasks/:id/move` | Placement move for the actor: `{groupId, beforeId?, afterId?}` → `{placement}`. `404` if the task isn't in the actor's list. | 2 |
| POST `/tasks/:id/reorder` | Among subtask siblings: `{beforeId?, afterId?}` → `{subtaskPosition}`. | 3 |
| POST `/tasks/:id/complete` | `{completed: boolean}` → `{task, next?: TaskDTO}` (`next` is the recurring instance, P10). | 2 |
| DELETE `/tasks/:id` | Soft delete (with descendants) → 204. | 2 |
| POST `/tasks/:id/restore` | Undo a delete, or restore from Trash. | 2 |
| DELETE `/tasks/:id/permanent` | Only from Trash (requires `deleted_at`). | 2 |
| POST `/tasks/:id/duplicate` | `{includeSubtasks: true}` → TaskDTO (placed after the original). | 3 |
| POST `/tasks/bulk` | `{ids: string[] (≤ 200), op: 'complete'\|'uncomplete'\|'delete'\|'restore'\|'move'\|'setDue'\|'addTag'\|'removeTag'\|'assign', args}` → `{results: [{id, ok, code?}]}`. Atomic per task, not across tasks. | 2 |
| PUT `/tasks/:id/tags/:tagId` · DELETE `/tasks/:id/tags/:tagId` | Add or remove a tag (set semantics, idempotent). | 3 |
| GET `/orgs/:orgId/trash` | Deleted tasks (TaskDTO with `deletedAt` and `deletedBy`), paged. | 2 |

### 2.5 Tags
| Method & path | Description | P |
|---|---|---|
| GET/POST `/orgs/:orgId/tags` | `{id?, name, color?}`. | 3 |
| PATCH/DELETE `/tags/:id` | Rename, recolour, delete (removes it from tasks). | 3 |
| POST `/tags/:id/merge` | `{intoId}`. | 3 |

### 2.6 Collaboration & notifications
| Method & path | Description | P |
|---|---|---|
| GET `/tasks/:id/activity?filter=all\|comments&cursor` | Merged feed of comments and activity, newest last. | 6 |
| POST `/tasks/:id/comments` | `{id?, body}`. Mentions are written `@[Name](user:<id>)`. → CommentDTO. | 6 |
| PATCH/DELETE `/comments/:id` | Author only. | 6 |
| PUT/DELETE `/tasks/:id/followers/me` | Follow or unfollow (unfollow = muted). | 6 |
| GET `/notifications?unread=true&cursor` | Paged. | 6 |
| POST `/notifications/read` | `{ids}` or `{all: true}`; `/notifications/unread` does the inverse. | 6 |
| GET/PUT `/me/notification-prefs` | A matrix `[{type, channel, enabled}]` plus `{reminderTime, digestTime}`. | 6/7 |
| GET/POST `/unsubscribe/:token` (outside `/api/v1`, **no auth**) | The token is HMAC-signed (with `AUTH_SECRET`) over `{userId, category}` and never expires. **GET only shows** a small localised page with an "Unsubscribe" button, because mail scanners open links in advance (ADR 0035). **POST** (the button, or RFC 8058 one-click via `List-Unsubscribe-Post`) disables that email category and renders the confirmation. | 7 |
| GET `/push/vapid-public-key` · POST/DELETE `/me/push-subscriptions` | Web Push. | 7 |

### 2.7 Attachments
| Method & path | Description | P |
|---|---|---|
| POST `/tasks/:id/attachments` | multipart `file` → AttachmentDTO. 413 if over the limit. | 10 |
| GET `/attachments/:id` | Stream or 302 to a presigned S3 URL. `?inline=1` for images. | 10 |
| GET `/attachments/:id/thumb` | WebP thumbnail. | 10 |
| DELETE `/attachments/:id` | The uploader or the task assignee. | 10 |

### 2.8 Search, export, calendar
| Method & path | Description | P |
|---|---|---|
| GET `/search?q=&orgId=&limit=` | `[{task: TaskDTO, orgId, snippet}]`. No `orgId` means all of the actor's orgs. | 5 |
| GET `/orgs/:orgId/export?format=json\|markdown` | The user's data in the org (my groups, my tasks with subtasks, comments, tags). | 5 |
| GET/POST `/me/ical-feeds` · DELETE `/me/ical-feeds/:id` | `{orgId?}` → `{url}` (shown once). | 10 |
| GET `/ical/:token.ics` | **Outside `/api/v1`, no auth (token-based).** `Cache-Control: private, max-age=900`. | 10 |

### 2.9 Events
`GET /api/v1/events` serves `text/event-stream` (see 04 §4.5). It sends `hello`, `invalidate` and `notification`. Clients reconnect with backoff; `EventSource` handles this natively, and the CLI/TUI uses `eventsource-parser` over fetch.

### 2.10 Admin (instance admins)
| Method & path | Description | P |
|---|---|---|
| GET/POST `/admin/allowlist` · DELETE `/admin/allowlist/:id` | `{kind:'email'\|'domain', value}`. | 1 |
| GET `/admin/users` · PATCH `/admin/users/:id` | List users; `{disabled: boolean}` (revokes sessions). | 1 |
| GET `/admin/backups` · POST `/admin/backups` · GET `/admin/backups/:name` | List, create now, download. | 2 (WP 2.9) |
| GET `/admin/system` | Version, DB size, WAL size, counts, job last-runs, configured features. | 11 |
| POST `/admin/push-keys/regenerate` | Replaces the VAPID keys and deletes all push subscriptions. | 7 |

### 2.11 OAuth, MCP and discovery (P9, 11)
| Method & path | Description |
|---|---|
| GET `/oauth/authorize` | The authorization endpoint (PKCE S256 required, `resource` required). It renders the consent screen (11 §3.1) for a signed-in user. |
| POST `/oauth/token` · POST `/oauth/revoke` | Code and refresh-token grants (refresh rotation); RFC 7009 revocation. |
| POST `/oauth/register` | Dynamic Client Registration, only with `ROOSTER_OAUTH_DCR=on` (deprecated in MCP). |
| POST/GET/DELETE `/mcp` | The remote MCP endpoint (Streamable HTTP, protocol 2026-07-28). OAuth bearer tokens with audience `<host>/mcp` only. |
| GET `/.well-known/oauth-authorization-server` | RFC 8414 metadata. |
| GET `/.well-known/oauth-protected-resource/mcp` · `…/api/v1` | RFC 9728 resource metadata (11 §5.2). |
| GET MCP Server Card (path per SEP-2127) · `/.well-known/ai-catalog.json` · `/.well-known/agent-skills/index.json` · `/.well-known/agent-skills/rooster/SKILL.md` · `/llms.txt` | Discovery (11 §6); off with `ROOSTER_AGENT_DISCOVERY=off`. |

All of these live outside `/api/v1`, need no session (except the consent screen), are rate-limited per IP, and do not appear in the OpenAPI document. `/mcp` is described by its Server Card.

## 3. Example: inline create, then move, offline-replayed

```http
POST /api/v1/orgs/0192…/tasks
Idempotency-Key: 0192f3a0-…-a1
X-Rooster-Edit-Time: 1759590000123
X-Rooster-Client-Id: 0192e000-…
Content-Type: application/json

{"id":"0192f3a0-…-t1","title":"Book dentist","dueDate":"2026-10-10",
 "groupId":"0192…-today","afterId":"0192…-prevTask"}

→ 201 {"id":"0192f3a0-…-t1","seq":118,"title":"Book dentist","dueDate":"2026-10-10",
       "placement":{"groupId":"0192…-today","position":"a1V"}, …}

POST /api/v1/tasks/0192f3a0-…-t1/move
Idempotency-Key: 0192f3a0-…-a2
X-Rooster-Edit-Time: 1759590004500

{"groupId":"0192…-prio","afterId":null,"beforeId":"0192…-firstPrio"}
→ 200 {"placement":{"groupId":"0192…-prio","position":"Zz"}}
```

## 4. DTO stability
DTO fields are **additive only** within v1. `packages/core/schemas` is the single source of truth: server response schemas and client parsers import the same zod objects. Contract tests (10 §3) validate every route's real responses against its declared schema.
