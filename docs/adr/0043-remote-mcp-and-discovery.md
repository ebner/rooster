# ADR 0043: Remote MCP endpoint and discovery documents

- Status: accepted
- Date: 2026-10-09
- Amends: 11 §5.2, §6.1
- Code: `apps/server/src/mcp/{route,challenge,in-process-client,jsonrpc}.ts`, `apps/server/src/routes/discovery.ts`

## Decisions
1. **`/mcp` request pipeline**, in this order:
   1. Origin check.
   2. Method: only POST; anything else gets `405 Allow: POST`.
   3. The bearer token from `Authorization` only.
   4. Token resolution: tokens over 512 characters are rejected unread, then `resolveOAuthBearer(…, 'mcp', ip)` runs.
   5. `Content-Type: application/json` (otherwise 415).
   6. `Accept` listing both JSON and SSE (otherwise 406).
   7. A 1 MB body cap (413).
   8. The scope pre-check.
   9. The per-grant rate limit.
   10. The SDK.

   Errors at the HTTP layer carry JSON-RPC bodies. Responses are `Cache-Control: no-store`.
2. **Origin:** a present `Origin` must equal the instance origin (403, before any token lookup). A missing one passes, since non-browser clients send none. `/mcp` sends no CORS headers, so browser-hosted MCP clients on other origins aren't supported; they couldn't send `Authorization` past a preflight anyway.
3. **Scope pre-check:**
   - Every `tools/call` in the body, whether one call or a batch, goes through `requiredScopes`. Any call not covered answers `403` with `WWW-Authenticate: Bearer error="insufficient_scope", scope="<union, in ALL_GRANT_SCOPES order>", resource_metadata="…"`.
   - The SDK gets the same parsed body, so the check sees exactly what runs.
   - A test asserts that every listed tool is in `TOOL_NAMES`.
4. **In-process client:**
   - `createRoosterClient` gets a `fetch` that calls `app.fetch(request, {[IN_PROCESS_ACTOR]: actor})` with `X-Rooster-Client: mcp/<version>`.
   - It strips `authorization`, `cookie`, `proxy-authorization`, `forwarded`, `x-forwarded-*` and `x-real-ip`.
   - It refuses any URL outside `<origin>/api/v1/`, checked after normalisation.
   - The actor reaches the per-request server factory through a `WeakMap<Request, Actor>`, so no token is held in SDK context.
5. **Rate limit:**
   - 120 `tools/call` per grant per sliding 60 s, in memory, on the app clock.
   - Each batch entry counts, and unknown tools count too. Other methods don't count.
   - Over the limit: `429` with `Retry-After`.
   - It runs after the scope check, so a 403 costs no budget. The per-user API limit still applies through the in-process calls.
6. **Protocol eras:**
   - Stateless: GET and DELETE get 405.
   - 2026-07-28 is served natively, and 2025-era clients through the SDK's stateless fallback, since most clients still speak those.
   - Open `subscriptions/listen` streams are capped at 64 per process, because the tool list never changes.
7. **Resource metadata** is served at `/.well-known/oauth-protected-resource/mcp` and at the root path. It lists `authorization_servers: ["<base>/api/auth"]`, the issuer of ADR 0041, which replaces `ROOSTER_BASE_URL` in 11 §5.2. These stay when discovery is off.
8. **Discovery documents**, pinned to the published texts on 2026-10-09:
   - **MCP Server Card** (SEP-2127, final; modelcontextprotocol/experimental-ext-server-card at 526201bb):
     - The extension reserves `<streamable-http-url>/server-card`, so the canonical path is **`/mcp/server-card`**, with `/.well-known/mcp/server-card.json` kept as an alias for older crawlers. The spec advises against `.well-known` for cards, which corrects 11 §6.1's guess.
     - The card has `$schema` `https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json` and media type `application/mcp-server-card+json`. It validates against the vendored published schema with Ajv.
     - The card schema has no `authentication` member, so the OAuth hint goes under `_meta["io.github.201works/authentication"]`, as SEP-2127 directs vendors. The card names no package: the CLI is not published to npm (ADR 0041 §5).
     - `serverInfo.name` matches the card (`io.github.201works/rooster`, title `rooster`).
   - **AI Catalog** (Agent-Card/ai-catalog, specVersion 1.0):
     - Served at `/.well-known/ai-catalog.json` as `application/ai-catalog+json`.
     - Entries: the card, the skill (`application/agent-skills+md`), the skills index, the OpenAPI document and `/llms.txt`.
     - Identifiers are `urn:air:<host>:…`.
   - **Agent Skills Discovery v0.2.0:**
     - The index is at `/.well-known/agent-skills/index.json`, and the skill at `…/rooster/SKILL.md`.
     - The digest field is **`digest: "sha256:<hex>"`** over the exact bytes served, which corrects 11 §6.1's `sha256`.
   - **`/llms.txt`.**
   - **No `robots.txt`:** the server doesn't serve one, and an `Agentmap:` line is optional.
9. **Serving the documents:**
   - Every one gets CORS `*` (GET, HEAD, OPTIONS), `public, max-age=3600`, and a strong ETag with `304` on revalidation.
   - They are built on first request and cached.
   - With `ROOSTER_AGENT_DISCOVERY=off`, every best-effort path is `404` and never the SPA shell.
   - They reveal no data; a test checks that they don't change as users and tasks are added.

## Consequences
- The Server Card is a young extension; the vendored schema and the `_meta` keys pin today's shape. When the card spec adds a first-class `authentication`, move it out of `_meta`.
- A reverse proxy in front of rooster must forward `/mcp`, `/mcp/server-card`, `/.well-known/*` and `/llms.txt` (an operator change).
