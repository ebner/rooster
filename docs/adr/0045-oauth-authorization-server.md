# ADR 0045: The OAuth authorization server, admin capability and linked identities

- Status: accepted
- Date: 2026-10-09
- Amends: 11 §2.4, §3.1, §4; 06 §1 (problem codes), §2.1, §2.11
- Builds on: ADRs 0041, 0042
- Code: `apps/server/src/auth/{auth,mount,actor,oauth-bearer,oauth-handoff,oauth-metadata,auth-paths,cimd-fetch}.ts`, `services/{oauth-grants,grant-service,grant-access,identity-service,admin-service}.ts`, `routes/{oauth,identities}.ts`, migration `0010_oauth_provider`

## Decisions
1. **Grant handoff:**
   - `consentReferenceId` reads the client from the provider's own request state (`getOAuthProviderState()`).
   - Inside the consent route, an `AsyncLocalStorage` (`consentHandoff`) supplies the exact `{userId, clientId, grantId}`, and a mismatch throws.
   - Without a live grant it returns the sentinel `rooster:no-grant`, so the provider shows consent instead of issuing a code.
   - The token endpoint refuses a code whose `referenceId` is missing, the sentinel, or a dead grant.
2. **Consent requests are the provider's signed query.**
   - better-auth redirects to `/oauth/consent?client_id=…&ba_param=…&sig=…`.
   - `GET`/`POST /api/v1/oauth/consent` take that query unchanged (`oauthQuery`) and verify it with the auth secret.
   - A tampered, unsigned or expired (10 min) query is `404 not_found`.
   - A signed-out authorize goes to `/login?<signed query>`. After sign-in the browser resumes at `/api/auth/oauth2/authorize` with the same query.
3. **"This session only"** means the grant ends when no token has been issued for it for 24 h.
   - "Use" is the newest `createdAt` of the grant's refresh or access tokens, else the grant's `updatedAt`, so no extra column is needed.
   - It is enforced at refresh (the grant is revoked and the client gets `invalid_grant`), per request, and on the SSE heartbeat.
   - A session-only grant has no `expiresAt`.
4. **`resource` is required (RFC 8707).**
   - The mount replaces a missing, repeated or foreign `resource` with a `urn:rooster:error:*` stand-in. The provider then answers `invalid_target` the standard way: to the validated redirect URI, with `state` and `iss`. So `resource_required` never appears as problem+json.
   - The token endpoint refuses more than one resource.
   - Resources are seeded synchronously by `GrantService.seedOAuthResources`, which disables rows of an earlier base URL.
5. **Scopes:**
   - **Default scope:** an authorize without `scope` gets `tasks:read offline_access`; the plugin's default would be every scope.
   - **What consent records:** the consent row holds everything the grant covers, plus `offline_access`, and accumulates resources. A later request for an implied scope, or for the other resource, skips the screen. Narrowing a grant in Connected apps rewrites the consent, so a wider request shows the screen again.
   - **Step-up:** it merges the new scopes into the old ones. `tasks:delete` is granted only when requested and ticked, and `authorization_details` only pre-fills constraints.
   - **One live grant per user and client:** an expired-but-unrevoked grant is revoked when a new consent replaces it.
   - **`newScopes`:** empty on a first request; it lists scopes only on step-up.
6. **The `/api/auth` mount:**
   - `/api/auth/oauth2/{token,revoke,register}` never see cookies.
     - Token and revoke keep only `Authorization: Basic`.
     - Register keeps no credential, so registration is always anonymous.
     - DCR is enabled only with `ROOSTER_OAUTH_DCR=on`, at the plugin's limit of 5 registrations per minute.
   - Every other `/oauth2/*`, `/admin/oauth2/*` and `/api/auth/.well-known/*` path is 404. The AS metadata is served filtered from `routes/oauth.ts`: no introspection, DPoP, backchannel, JWKS or `client_credentials`, with CORS `*`.
   - Loopback DCR clients must register with `application_type: 'native'` (the plugin's rule). Native CIMD clients registered with `http://127.0.0.1/callback` work with any port. Both show as loopback and unverified.
7. **The bearer resolver:**
   - `resolveOAuthBearer(services, token, resource, ip)` returns an actor with `via: 'oauth'` and `grant.resource`.
   - Scopes and constraints come only from the rooster grant, with `admin` filtered out for OAuth grants.
   - It is null for an unknown, expired or revoked token, the wrong audience, a dead or idle grant, a user or client mismatch, or a disabled user.
   - Activity records `via: 'mcp'` for `/mcp` tokens and `via: 'oauth'` for `/api/v1` tokens.
8. **The CIMD fetch** is our own `auth/cimd-fetch.ts`, which is testable with injected DNS and connections.
   - https and GET only, with no credentials in the URL.
   - Every DNS answer must be public; for IPv6, only global unicast 2000::/3.
   - Refused: RFC 6890 ranges, CGNAT, mapped and compatible IPv4, NAT64, 6to4, Teredo, ULA, link-local and multicast.
   - The connection is pinned through `lookup`, keeping SNI and Host.
   - No redirects; 5 KB and 5 s caps; 24 h revalidation; the MCP profile.
9. **Plugin quirks:**
   - Its types fail `exactOptionalPropertyTypes`, so the plugin is cast to `BetterAuthPlugin` and reached through `oauthProviderApi(auth)`.
   - `oauth2Consent` needs a `request` and returns a `Response`.
   - Its CIMD fetch errors come back as `400 invalid_client` JSON, not a redirect.
   - The seven plugin tables are non-STRICT, like the other better-auth tables.
10. **The admin capability** (`requireAdminAccess`):
    - It admits the browser session, or a PAT or device grant holding `admin`, and always requires `actor.isAdmin` at that moment. OAuth grants never qualify.
    - It covers allowlist, users, backups and reindex. Push-key regeneration stays browser-only.
    - Device requests accept `admin`, and it is dropped silently for non-admins.
    - Adding it through PATCH or a new PAT as a non-admin is `403 admin_only_scope`.
11. **Linked identities** are better-auth `account` rows, with the provider name from config. The email is shown from the stored ID token. Unlinking the last identity is `409 last_identity`.

## Consequences
- The new problem codes are `admin_only_scope` and `last_identity`.
- The migration is `0010_oauth_provider`: the seven plugin tables (`oauthClient`, `oauthResource`, `oauthClientResource`, `oauthRefreshToken`, `oauthAccessToken`, `oauthConsent`, `oauthClientAssertion`), indexes on `reference_id`, and `access_grant.idle_timeout_ms`.
- DCR's per-IP limit is the plugin's default and is not covered by tests, because tests run with the limiter off.
