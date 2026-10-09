# ADR 0041: Phase 9 decisions (OAuth server, MCP delete, session-only grants, naming)

- Status: accepted
- Date: 2026-10-09
- Amends: 11 §1, §2.1, §2.4, §4.1, §4.2, §5.2, §6.1, §7, §8; 06 §2.11; 07 §6; 09 Phase 9
- Settles: the three open questions of 11 §8, plus the scope of Phase 9

## Context
11 §8 left three questions for the P9 contract: whether better-auth's OAuth 2.1 provider can carry rooster grants, whether `tasks:delete` should ever reach MCP, and whether the consent screen should offer "this session only". They were settled on 2026-10-09 together with the MCP naming, npm distribution and two deferred items. A spike checked `@better-auth/oauth-provider` and `@better-auth/cimd` 1.7.7 against the repo's pinned `better-auth` 1.7.7.

## Decisions
1. **The authorization server is better-auth's OAuth 2.1 Provider plus CIMD, with rooster adapters.** We don't build an in-house AS.
   - Pin `@better-auth/oauth-provider` and `@better-auth/cimd` exactly. Run the OAuth conformance suite (11 §7) on every bump.
   - **Issuer and paths follow the plugin:** the issuer is `<ROOSTER_BASE_URL>/api/auth`, the endpoints are `/api/auth/oauth2/{authorize,token,revoke}` (plus `register` with DCR on), and the RFC 8414 metadata is at `/.well-known/oauth-authorization-server/api/auth`. This is standards-valid (RFC 8414 §3 path insertion) and replaces the root issuer and `/oauth/*` paths in 11 §4.1 and 06 §2.11.
   - **Consent:** the plugin's `consentPage` redirects to rooster's SPA route `/oauth/consent`, which renders the shared consent component (11 §3.1) and answers through `oauth2Consent`.
   - **Grant id on tokens:** the plugin's `referenceId` on access tokens, refresh tokens and consent rows holds the rooster `access_grant.id`. `consentReferenceId` receives neither the client nor the request, so our consent and authorize handlers pass `{clientId, grantId}` to it through an `AsyncLocalStorage`. Tests must fail if the handoff ever yields no grant.
   - **Adapters:**
     - Reject a missing `resource`, or more than one.
     - Never advertise `openid`, because `openid` plus `nonce` waives PKCE.
     - Disable introspection, userinfo, client CRUD, prelogin, end-session, DPoP, PAR, backchannel and `client_credentials`.
     - A reused refresh token revokes the rooster grant, and revoking a grant deletes its plugin tokens and consent in the same transaction.
     - `/api/auth/oauth2/{token,revoke,register}` are exempt from the browser-only rule for `/api/auth` (ADR 0037).
     - `actorMiddleware` gains an OAuth-token branch: look up the hashed opaque token, then check its expiry, revocation, the audience (`resource`) and the grant.
2. **`tasks:delete` may reach MCP, only by explicit consent.**
   - The consent screen shows an "Allow deleting tasks" checkbox **only when the client requested `tasks:delete`**. It is unticked by default, and `authorization_details` can't pre-tick it.
   - With it, MCP lists a `delete_task` tool. The tool soft-deletes to Trash under the grant's write constraints and tells the agent the task can be restored for 30 days. There is still no tool that deletes groups or deletes permanently.
   - `rooster mcp setup` requests no `tasks:delete` unless `--allow-delete` is passed, so the device consent page shows the same checkbox. `--read-only` hides it like every other write tool.
3. **"This session only" expiry for OAuth grants.** A grant can carry an idle timeout, alongside 7/30/90 days, a date or never. It ends when its refresh token has gone unused for 24 hours. It is stored as `idle_timeout_ms` on `access_grant`, enforced at refresh and at each request, and offered only on the OAuth consent screen. CLI devices and PATs have no refresh token.
4. **The MCP name is `io.github.201works/rooster`.** The Server Card and a future MCP Registry entry use it, since GitHub login proves the namespace. Registry publishing is not scheduled.
6. **The CIMD fetch guard is IP-based, not the push host allowlist.**
   - It uses https only, resolves DNS once, requires every answer to be public, pins the connection to that address and refuses redirects. It also has the plugin's 5 s timeout and 24 h revalidation.
   - The size cap is the plugin's 5 KB rather than 32 KB, which is stricter and enough for a metadata document.
   - `@better-auth/cimd/node`'s fetcher qualifies if a test proves those properties; otherwise we wrap it.
7. **Phase 9 also takes two deferred items:**
   - **Linked identities** (FR-SET-3): Settings → Security lists the sign-in identities and unlinks one, but never the last.
   - **An `admin` capability:**
     - It is offered only to instance admins, on PAT creation and CLI login, and never to OAuth or MCP clients.
     - It reaches the admin routes (users, allowlist, backups, reindex, system), and is checked against the user's current admin role on every request.
     - This unblocks `rooster admin reindex` (ADR 0013).

## Consequences
- 11, 06, 07 and 09 are amended to match, and AC-9.6 covers the extras.
- The plugin is young and released almost weekly, so the exact pins and the conformance suite are the guard rails. If an upgrade breaks the grant handoff, an in-house AS is still the fallback; the spike sized it at about 1,500 LOC plus tests.
- The Phase 9 security review (independent, as for P6–P8) covers the adapters, the consent route, the CIMD guard and the remote MCP endpoint.
