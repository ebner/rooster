# ADR 0042: Phase 9 contract (agent access, MCP, TUI)

- Status: accepted
- Date: 2026-10-09
- Amends: 07 §5–§6, 11 §2.1, §3.1, §5.1–§5.2 (see Conflicts)
- Builds on: ADR 0041 (the settled open questions)
- Code: `packages/core/src/{grants,schemas/grants}.ts`, `packages/mcp/**`, `apps/server/src/{lib/in-process,auth/oauth-bearer,mcp/route,routes/{oauth,identities,discovery,p9-deps}}.ts`, `apps/cli/src/{commands/{mcp,skill,admin},tui/index}.ts`

## Decisions
1. **Scopes.**
   - `GRANT_SCOPES` stays the seven user capabilities.
   - `ADMIN_SCOPE` (`admin`) is added in `ALL_GRANT_SCOPES`, which the schemas accept, and `OAUTH_EXCLUDED_SCOPES` lists what OAuth and MCP clients can never get.
   - The CLI's default login still requests `GRANT_SCOPES`. `rooster login --admin` adds `admin`.
   - The device page offers `admin` only to instance admins. Requests from anyone else drop it silently.
   - Creating a PAT with `admin` as a non-admin is `403 admin_only_scope`.
2. **Grant DTO additions (additive):**
   - `idleTimeoutMs`: "this session only", `SESSION_ONLY_IDLE_MS` = 24 h.
   - `client` (`OAuthClientInfo`: name, domain, logo, verified, dynamic): null for PATs and devices.
3. **New REST routes (session only, in the OpenAPI document and the authz matrix):**

   | Route | Response |
   |---|---|
   | `GET /api/v1/oauth/consent?oauth_query=…` | `OAuthConsentRequest` |
   | `POST /api/v1/oauth/consent` | takes `OAuthConsentDecision`, returns `OAuthConsentResult` (`redirectTo`) |
   | `GET /api/v1/me/identities` | `LinkedIdentity[]` |
   | `DELETE /api/v1/me/identities/:id` | `204`, or `409 last_identity` |

   - The SPA route `/oauth/consent` is where `consentPage` points.
   - New error codes: `admin_only_scope` (403), `last_identity` (409), `resource_required` (400, OAuth `invalid_target` on the authorize redirect).
4. **The consent checkbox for deleting** shows when the request includes `tasks:delete`.
   - On the OAuth consent screen it is unticked by default.
   - On the device page it starts as requested, since `rooster mcp setup --allow-delete` or a full CLI login asked explicitly in the terminal.
   - `authorization_details` never ticks it.
5. **The remote MCP endpoint calls the REST API in-process.**
   - `packages/mcp` implements every tool once, against `@rooster/api-client`.
   - stdio passes the CLI profile's client. `/mcp` passes a client whose `fetch` is `app.fetch(request, { [IN_PROCESS_ACTOR]: actor })`. The actor middleware takes that actor, which a symbol key makes unreachable from HTTP.
   - So routes, service authorisation, the per-user rate limit, idempotency and activity attribution (`via: mcp`) all apply unchanged, and the OAuth token never leaves the edge (11 §7, no token passthrough).
   - `ActorVia` gains `oauth`, which CSRF treats as token auth.
6. **Tool listing** (`ToolListing`):
   - stdio uses `granted`: only tools within the grant's scopes, and `--read-only` narrows further.
   - `/mcp` uses `step-up`: every tool except `delete_task` without `tasks:delete`.
   - A remote call that needs scopes the token lacks is answered by the HTTP layer, before the SDK, with `403` and `WWW-Authenticate: Bearer error="insufficient_scope", scope="<all needed>", resource_metadata="…"` (`requiredScopes`).
   - A constraint miss is a tool result with `isError: true` (11 §2.3).
7. **Packages:**
   - MCP SDK v2 is the split packages: `@modelcontextprotocol/server` 2.3.1 (stdio and Web-standard Streamable HTTP), with `@modelcontextprotocol/client` 2.3.1 for tests.
   - The TUI uses **Ink 8.0.0**, the current major (React 19.3, Node ≥ 22), rather than Ink 6; with `ink-testing-library` 4.
   - `@better-auth/oauth-provider` and `@better-auth/cimd` 1.7.7 are pinned exactly.
8. **Env:** `ROOSTER_OAUTH_DCR` (default off) and `ROOSTER_AGENT_DISCOVERY` (default on), both `on|off`.
9. **i18n:** the TUI has its own `tui` namespace. The CLI's new command strings are in `cli`.

## Conflicts flagged
- 11 §5.1 says a token without write scopes lists only read tools on `/mcp`, but AC-9.4 needs a read-only token to call `create_task` and get a scope challenge. Decision 6 follows AC-9.4 and the MCP step-up model.
- 07 §5 names Ink 6; Ink 8 is used (decision 7).
