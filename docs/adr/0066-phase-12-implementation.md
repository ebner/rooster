# ADR 0066: Phase 12 implementation decisions (device grant, MCP tokens, CLI)

- Status: accepted
- Date: 2026-10-21
- Amends: 11 §2.4 (refresh grace), §9; ADR 0045 (refresh reuse); ADR 0065
- Code: `apps/server/src/auth/device-grant.ts`, `services/device-codes.ts`, `auth/mount.ts`, `services/grant-service.ts`, `mcp/route.ts`; `apps/web/src/features/access/device-page.tsx`, `connected-apps.tsx`; `apps/cli/src/oauth.ts`, `profile-lock.ts`, `runtime.ts`, `commands/mcp.ts`

## Context
ADR 0065 records the product decisions for headless agent access. The implementation made further choices where 11 §9 was silent. This ADR collects them, together with the refresh-token grace period added during the phase.

## Decisions

### Server
1. **Rooster's own endpoint creates the new flow's codes.** `POST /api/auth/oauth2/device-authorization` is a rooster better-auth endpoint, not the provider plugin's `/device/code` path. The code is hashed when it is created, the operator switch is checked before any client metadata is fetched, and rooster shapes the answer, which never has `verification_uri_complete`. The legacy CLI flow stays in better-auth's device plugin: its codes are hashed after the plugin writes them and before the answer leaves, and the code presented at `/device/token` is hashed before the lookup.
2. **`rooster-cli` is seeded as an OAuth client row at boot:** public, with the device grant and refresh only, and no redirect URIs.
3. **The CIMD adapter.** The `mcp-2026-07-28` profile is wrapped:
   - Every client keeps the `client_name` rule.
   - A client without redirect URIs resolves only on device authorization, token and revoke; anywhere else, including authorize, it is `invalid_client`.
   - Device clients always get `refresh_token` and `offline_access`.
   - DCR clients and other non-URL ids get `unauthorized_client`.
4. **Scopes:**
   - An app that names no scope gets `tasks:read`.
   - `admin` from an app is `invalid_scope`.
   - A `rooster-cli` login for `/mcp` silently loses `admin`.
5. **Rate limits:**
   - 10 device authorization requests per 10 minutes per IP, across the new and the legacy endpoint.
   - 30 per hour per third-party client.
   - Code entry locks after 10 wrong codes per user in 10 minutes. While locked, every lookup, approve and deny answers `429 rate_limited`, whatever was typed.
   - All limits are in memory, like the other limiters (one process, 04 §1).
   - A decision with a stale `decisionNonce` answers `404` and doesn't count as a wrong code.
6. **The operator switch changed later:**
   - A pending code whose client the switch no longer allows answers `404` at `/device`, and the token endpoint refuses it.
   - Grants created before the change keep refreshing; revoke them in Connected apps if needed.
7. **Revocation:** revoking a `rooster-cli` refresh token at `/oauth2/revoke` ends the login's grant. Revoking an app's refresh token revokes only that token, as RFC 7009 intends; its grant is shared with the browser flow.
8. **Storage:** a CLI login's audience is in `access_grant.audience`; a PAT's audience is in the `apikey` metadata (absent means `api`).
9. **The `device_connected` notice:**
   - It is sent for every approval in the new flow, `rooster-cli` included. Amended before publication (2026-11-02): the legacy CLI flow sends it too, since it is phishable alike and `ROOSTER_OAUTH_DEVICE=off` leaves it on as the CLI's fallback.
   - For the CLI, `clientName` is the grant label and there is no `clientHost`.
   - It is emailed at once, whatever the batching setting, with no unsubscribe link, and links to Connected apps.
10. **`authorization_details`** on a device authorization request is accepted and ignored, and refused above 8 KB.
11. **MCP tokens at `/mcp`:** the tools are listed as for OAuth tokens. A missing scope answers `403` with the `insufficient_scope` challenge and a message pointing to Connected apps, because a PAT can't step up.
12. **Test seam:** `deviceIntervalSec` on the app dependencies (default 5) shortens polling in tests. It is not an environment variable.

### The refresh-token grace period (decided during the phase)
Before Phase 12, any reuse of a rotated refresh token revoked the grant (ADR 0045). A response lost in transit, or a keychain write that failed after the server rotated the token, then logged the CLI out for good. Decided: a short grace period. better-auth's `refreshTokenReuseInterval` replays the identical stored response, and rooster refuses rotated tokens before it would apply anyway, so the grace period is rooster's own:
- **The window** is `REFRESH_GRACE_MS = 60_000`, counted from the old token's rotation.
- **When the old token works once more:** a rotated (not revoked) refresh token may be redeemed one more time when all of these hold:
  - it was rotated within the window;
  - it hasn't had its retry;
  - its recorded successor is unused (neither rotated nor revoked);
  - the grant is live and passes the usual idle checks.
- **What the retry does:** in one transaction it revokes the successor and that successor's access tokens, makes the old token current again and marks its retry used. The provider then rotates it into a fresh pair.
- **Every other reuse still revokes the whole grant:** after the window, after the successor was used, a second retry, or a revoked token.
- **Concurrency:**
  - Refreshes are serialised per grant.
  - Of two concurrent retries of the same old token, one wins, and the other counts as reuse and revokes the grant: two holders of one old token signal theft.
  - A crash between rotating and recording the successor fails closed: a later retry counts as reuse.
- **Residual risk:** a thief who steals a refresh token and uses it within 60 s of a rotation, before the real client uses its successor, gets one pair and revokes the real client's unused successor. The real client's next refresh then counts as reuse and revokes the grant, so the theft surfaces within one refresh cycle. Whether the successor's access token was used is not tracked.

### Web
13. **The code is always typed.** `?user_code=` in the URL (older CLIs open `verification_uri_complete`) is ignored: the field stays empty and a note says to type the code the device shows, because codes in links aren't accepted. A first version pre-filled the field; the security review showed it made approval "Enter, then Allow" for any link an attacker sent, which is what ADR 0065 rejected. Nothing is looked up until the user presses Continue.
13a. **Delete and admin start unticked for every client,** `rooster-cli` included: anyone can start a `rooster-cli` device flow and ask for them, so ticking them must be a deliberate act (11 §9.3). The CLI keeps its other defaults (all orgs, never expires). Before Phase 12 the CLI's device page ticked every requested capability, including delete (ADR 0046).
13b. **The notice and the approval page don't trust names.** A `rooster-cli` notice says "rooster CLI" and the IP the server saw, never the device name the CLI reports. A third-party client whose name contains "rooster" is shown under its domain.
14. **Deny comes first in the reading order.** On phones the shared `ConsentActions` stacks Allow above Deny, as on the OAuth consent screen. Both buttons stay equally prominent, which RFC 10027 §6.1.14 allows.
15. **Step-up:** the existing grant's scopes stay ticked and fixed, and approval merges as the consent flow does (ADR 0045 §5).
16. **New tokens always send `audience`,** `api` included. MCP setup lines use the page's origin as the instance URL.
17. **The inbox notice** shows a shield instead of an actor, says "Your account" in place of the org, and opens Connected apps at the grant (`/settings/security#grant-<id>`).

### CLI
18. **Resource discovery.** The CLI reads the canonical `resource` from the server's RFC 9728 documents, because the URL it uses can differ from the configured base URL (tests, proxies). It accepts only https (or http on loopback) with the matching path and no credentials, query or fragment, and otherwise falls back to `<server>/api/v1`. The resource is an identifier only: tokens go only to the profile's server.
19. **The stored secret.**
    - Bearer logins (legacy sessions and PATs) keep the 1.7 shape.
    - OAuth logins are `{v:2, kind:"oauth", token, server, refreshToken, expiresAt, audience, resource, scopes}`; an unknown version or kind is refused.
    - A refresh replaces the secret in place, only under the profile lock.
20. **The profile lock.**
    - It is `<configDir>/locks/<sha256(profile)>.lock`, created exclusively with mode 0600 in a 0700 directory.
    - A lock is stale when its holder on the same host is dead or it is older than 120 s. A takeover renames it aside and verifies it moved the lock it judged.
    - Inside the lock the stored secret is re-read, so a concurrent refresh is used rather than repeated.
    - SIGTERM, SIGINT and SIGHUP are deferred until new tokens are stored.
21. **The lost-refresh retry.** A refresh that fails with a network error, a timeout or a 5xx is retried once after 1 s, inside the lock, which lands inside the grace window. `invalid_grant`, other 4xx and 429 are never retried. If storing the new tokens fails, the previous login is kept (for the keychain, best effort), and a rerun within a minute recovers through the grace period.
22. **`rooster mcp header`** follows Claude Code's `headersHelper` contract: a shell command, JSON of string values on stdout, a 10 s limit, run on every connection. It prints `{"Authorization":"Bearer …"}` with a token valid for at least 5 minutes. It ignores `ROOSTER_TOKEN` and `ROOSTER_SERVER`, and waits at most 6 s for another refresh.
23. **`mcp setup --remote --client claude-code` writes no file.** It prints a `claude mcp add-json --scope user …` command with the shell-quoted absolute path of the helper. ADR 0044 §5 forbids editing Claude Code's private files. Cursor gets the MCP-token explanation; Claude Desktop is pointed to its custom-connector setting, which uses the browser flow.
24. **A remote (`mcp`) login skips `/me`,** because its token can't call `/api/v1`, so the profile has a server and a credential but no user or org.
25. **`token create --audience`:** `api` isn't sent, so older servers keep working, and `--audience mcp` with `--scope admin` is refused locally.

## Changes from the security reviews
The review rounds are logged in `docs/security/security-review.md` (Phase 12).
- **Refresh grace:**
  - A refused grace retry (wrong `resource`, an error from the provider) rolls back exactly what it changed. It never revives the old token, and never clears a revocation it didn't make, such as a sign-out.
  - A rotated refresh token that is revoked by name is never redeemed through the grace.
  - Revoke strips a `Bearer ` prefix before classifying.
  - Revoking any `rooster-cli` refresh token, current or stale, ends that login's grant only.
- **`device_connected`** is visible to the browser session only. Apps and tokens can't list it, count it or mark it read.
- **Codes:** user codes are an HMAC keyed with the auth secret. Device codes stay plain SHA-256: they have 256 bits.
- **Request log:** `/api/v1/device/<code>` is logged with the code redacted.
- **`admin`** can't be added to an MCP token or a `/mcp` login by editing the grant (`422 admin_not_for_mcp`).
- **The CLI:**
  - It never follows redirects (`cliFetch` uses `redirect: 'manual'`).
  - `mcp header --server` binds the helper to its server.
  - Only a 2xx or 5xx with a lost body counts as a lost refresh.
  - A keychain read-back that fails after a successful write keeps the new tokens.
