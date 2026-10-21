# ADR 0065: Headless agent access through the OAuth device grant and MCP tokens

- Status: accepted (scheduled as Phase 12, 09)
- Date: 2026-10-21
- Amends: 11 §4.1, §4.2, §7 (adds §9); 04 §4; 05; 06; 07 §2, §4
- Spec: 11 §9

## Context
Agents often run where no browser can receive an OAuth redirect (SSH, containers, CI-like runners). The remote MCP endpoint only accepts tokens from the browser code grant, and refuses PATs.

Research on 2026-10-21 found:
- **The MCP spec doesn't cover the device grant.** The 2026-07-28 revision covers the code grant (and `client_credentials` in `ext-auth`). SEP-2059 (device flow) was closed on 2026-01-09; `ext-auth` issue #18 is open.
- **No major client implements it:** not Claude Code, Codex, Gemini CLI, VS Code, Cursor or mcp-remote. Their headless workarounds are pasting the callback URL, forwarding the callback port, or a static bearer token.
- **Device-code phishing is widespread** (Storm-2372 since 2024; mass campaigns and phishing kits against Microsoft 365 in 2025–26). RFC 10027 (BCP 247, 2026-08) allows the device grant only with an explicit risk assessment and mitigations.
- **better-auth 1.7.7's `oauthDeviceAuthorization` can't be used as it is:**
  - it can't coexist with the CLI's `deviceAuthorization` plugin;
  - it issues tokens without `referenceId`, which rooster requires;
  - its approval endpoint has no decision binding;
  - the `deviceCode` table lacks the columns it needs.

  Its pieces (`redeemDeviceCode`, `extendOAuthProvider`, `issueTokens` with `referenceId`) are reusable.
- **Spec 04 §4 says device codes are stored hashed.** In fact better-auth's device plugin stored them in plaintext. Phase 12 hashes both codes (ADR 0066 §1).

## Decisions (2026-10-21)
1. **Both mechanisms.** The RFC 8628 device grant on rooster's AS, and PATs with an `mcp` audience accepted at `/mcp`. The second works with every client today.
2. **Clients:** any client with a Client ID Metadata Document that lists the device grant, always shown as **Unverified** with its host and without a logo, since the flow can't bind a `client_id` to its sender. Plus `rooster-cli`. DCR clients never.
3. **Operator switch** `ROOSTER_OAUTH_DEVICE=off|first-party|all`, default `first-party` (only `rooster-cli`).
4. **No `verification_uri_complete`.** The user types the code on `/device`.
5. **Access as on the browser consent screen:** the same editor and defaults, delete only by explicit checkbox, never `admin` for apps, "This session only" for apps.
6. **The approval page shows full context:** client and verification state, account, the code to compare, the request IP and age, the warning, and Deny first.
7. **MCP tokens are audience-bound:** a PAT is `api` or `mcp`, never both.
8. **The CLI moves to the device grant.**
   - `rooster login` gets rotating OAuth tokens. Legacy device sessions keep working, and the legacy flow is removed at the next major.
   - `rooster mcp header` and `mcp setup --remote` let header-helper clients use the remote endpoint.

Decided while writing the spec (no question to the user):
- `resource` is required with exactly one value.
- Codes are hashed: user code 40 bits, 10-minute lifetime, interval 5 s.
- Rate limits: device requests per IP and per third-party client; 10 code misses per user per 10 minutes.
- `rooster-cli` approvals create one `kind:'device'` grant per login. A third-party client shares the user's single `kind:'oauth'` grant for it with the browser flow.
- A non-optional `device_connected` notice (in-app, and email when configured) after every device-grant approval.
- The new device endpoint lives at `/api/auth/oauth2/device-authorization`, so the legacy `/api/auth/device/code` can stay for old CLIs.

## Risk assessment (RFC 10027 §2)
- **Assets:** the user's tasks in the orgs and groups they choose, and the ability to act as them within the capabilities granted.
- **Attacker:** a remote party who starts a flow with a real or look-alike client and persuades the user to type the code (by mail, chat or a fake support call). They need no foothold on the user's devices.
- **Impact:** a grant limited to what the user approved, at most until it expires or is revoked. Never admin. No delete unless ticked.
- **Mitigations (RFC 10027 §6.1):**
  - short-lived, single-use, unique, hashed codes;
  - limited scopes with least-privilege defaults;
  - 15-minute access tokens and rotated refresh tokens with reuse revocation;
  - rate limits;
  - the full-context approval page with the warning, no pre-filled link and Unverified labels;
  - the `device_connected` notice for detection, and revocation in Connected apps;
  - the operator switch, defaulting to first-party.
- **Residual risk:** a user who ignores the warning and approves a request someone else started. `first-party` mode limits only which client a flow names. `rooster-cli` is a public client, so anyone can start a flow in its name (the legacy CLI flow allowed the same since Phase 8). What protects the user is therefore the approval page, for every client:
  - the code must be typed;
  - delete and admin start unticked;
  - the notice names the client and the server-observed IP, not a self-reported device name.

  This was corrected after the Phase 12 security review (ADR 0066 §13–13b). A warning when the requesting IP differs from the approving browser's was considered and left out: approving a terminal on another machine (SSH, a server) is the flow's normal use.

## Considered
- **The device grant only:** few clients would use it, so headless MCP would stay impractical.
- **MCP tokens only:** no new phishing surface, but no rotation, and no path for clients that adopt the grant later.
- **Pre-registration of third-party device clients by the operator:** stronger identity, but an admin step per client. The Unverified label and the operator switch were preferred.
- **Pre-filled verification links** (with a confirmation step): convenient for QR codes, but they are what phishing kits rely on.
