# OWASP ASVS 4.0.3, Level 2: the subset that applies to rooster

WP 11.1, AC-11.2. Each requirement rooster can meet or miss is listed with its status and the
evidence: a test, a source file or an ADR. Paths are relative to the repo root; `server/` is
`apps/server/`, `web/` is `apps/web/`, `cli/` is `apps/cli/`.

**Status:** **met** (implemented, with the evidence named), **partial** (implemented in part;
the rest is said), **gap** (not met; see [Gaps](#gaps)), **n/a** (does not apply, with the
reason).

**What rooster is, for scoping:** a self-hosted, single-container web app and API. Sign-in is
only through OpenID Connect providers (no passwords, ever), so authentication strength, MFA and
account recovery belong to the identity provider. TLS ends at the operator's reverse proxy. The
data is one SQLite file plus attachment blobs (local or S3).

**Chapters left out entirely:** V2.1 (passwords), V2.4 (credential storage), V2.5 (credential
recovery), V2.6–V2.8 (look-up secrets, out-of-band and one-time verifiers), V2.9 (cryptographic
verifiers): rooster has no local credentials; the IdP holds them. V6.2.5–V6.2.8 and V6.4 (key
vaults, custom crypto): rooster uses Node's `crypto` (SHA-256, HMAC, random bytes) and
better-auth, no own algorithms. V13.3 (SOAP) and V13.4 (GraphQL): not used.

## V1 Architecture, design and threat modelling

| ID | Requirement (short) | Status | Evidence |
|---|---|---|---|
| 1.1.2 | Threat modelling for design changes | partial | Per-phase independent security reviews (ADR 0040; AGENTS.md → Reviews), the trust boundaries listed in 09 Phase 11 (WP 11.2). No standalone threat model document. |
| 1.1.4 | Trust boundaries documented | met | 09 Phase 11 (the ten boundaries of the security audit), 04 §4.11, 11 (agent access). |
| 1.2.1 | Unique, low-privilege OS accounts for components | met | `docker/Dockerfile` (distroless `nonroot`, UID 65532); `scripts/docker-smoke.sh` checks it. Litestream sidecar runs as the same UID (`compose.litestream.yaml`). |
| 1.2.3 | One vetted authentication mechanism | met | better-auth for every sign-in (`server/src/auth/auth.ts`, ADR 0002); PATs and OAuth tokens resolve through `GrantService` / `resolveOAuthBearer` only. |
| 1.4.1 | Trusted enforcement points for access control | met | Authorisation only in services (AGENTS hard rule 1; `server/src/services/grant-access.ts`). |
| 1.4.4 | One access-control mechanism | met | `authorizeOrg` / `authorizeTaskRead` / `authorizeTaskWrite` / `requireAdminAccess` in `grant-access.ts`; `server/test/authz.matrix.test.ts` enumerates every OpenAPI route × 15 actor kinds. |
| 1.5.1 | Input and output handling defined | met | zod schemas shared in `packages/core/src/schemas`, the OpenAPI document, response validation in e2e (AC-8.4, `server/src/lib/response-contract.ts`). |
| 1.6.2 | Key material protected | met | Secrets only from env or `<NAME>_FILE` (`server/src/config.ts`); weak `ROOSTER_AUTH_SECRET` exits 78 (`server/test/config.test.ts`); gitleaks in CI (`scripts/secret-scan.sh`, ADR 0052 §5). |
| 1.8.1 | Sensitive data identified and classified | partial | Classified in practice (task content, emails, tokens, OAuth grants are treated as sensitive: hashing, log scrubbing), but not written down as a classification. |
| 1.14.6 | No unsupported, insecure client-side technology | met | React SPA only; no plugins, no CDN (08 §10). |

## V2 Authentication

| ID | Requirement (short) | Status | Evidence |
|---|---|---|---|
| 2.2.1 | Anti-automation against credential attacks | met | better-auth's limiter on `/api/auth/*` (30 per minute per client IP, `server/src/auth/auth.ts`); per-user API limit (`server/src/lib/rate-limit.ts`); iCal token guessing limited per IP (`server/test/ical.test.ts` "limits token guessing"). |
| 2.2.2 | Weak authenticators restricted | n/a | No passwords, SMS or email codes; the IdP decides. |
| 2.2.3 | Notification after authentication changes | partial | Linking an identity needs a signed-in session and is shown in Settings (ADR 0045/FR-SET-3); no email is sent about it. |
| 2.3.1 | System-generated secrets are random and shown once | met | PATs and device tokens: 256-bit random, stored hashed, shown once (`server/src/services/grant-service.ts`, `token_shown_once`); `server/test/grants.test.ts`. |
| 2.10.1 | Service credentials not hard-coded | met | SMTP, S3, VAPID and OIDC secrets from env (`config.ts`); gitleaks (ADR 0052 §5). |
| 2.10.4 | Secrets, keys and passwords not in source | met | As 2.10.1; `.gitleaksignore` pins only test fixtures. The 1.4.0 migration fixture leaves the VAPID keys out (`server/test/fixtures/make-release-fixture.ts`). |
| — | Allowlist bypass with an unverified email claim (10 §6) | met | `server/test/auth-flow.test.ts` "rejects an unverified email even when it is allowlisted", "an untrusted provider asserting an existing verified email cannot sign in as that user"; linking only from email-authority providers (ADR 0017). |

## V3 Session management

| ID | Requirement (short) | Status | Evidence |
|---|---|---|---|
| 3.1.1 | No session tokens in URLs | met | Cookie or `Authorization` header only. The calendar feed URL is a deliberate capability URL (hashed, revocable, rate-limited; ADR 0049 §4) and grants read access to that feed only. |
| 3.2.1 | New token on authentication | met | better-auth creates a session per sign-in (`server/test/auth-flow.test.ts`). |
| 3.2.2 | ≥ 64 bits of entropy | met | better-auth session tokens; own tokens 256 bits (`server/src/lib/tokens.ts`). |
| 3.2.3 | Tokens stored securely in the browser | met | HttpOnly cookie, never readable by script (`server/test/auth-flow.test.ts` cookie tests). |
| 3.3.1 | Logout invalidates the session | met | Sign-out deletes the session row; the web clears local data (`web/src/data/sync/engine.ts` `clearLocalData`, ADR 0017). |
| 3.3.2 | Periodic re-authentication | partial | Sessions last 30 days, renewed daily while used (`auth.ts`: `expiresIn`, `updateAge`). No absolute maximum beyond that; OAuth refresh-token reuse revokes the grant (ADR 0045). |
| 3.3.3 | Option to end all other sessions | met | Settings → Sessions lists and revokes sessions (`DELETE /me/sessions/{id}`); deactivating a user ends every session (`AdminService.setDisabled`). |
| 3.3.4 | Users can see their active sessions | met | `GET /me/sessions` (`server/src/routes/me.ts`). |
| 3.4.1 | Cookie `Secure` | met | On https (`__Host-` names), `server/test/auth-flow.test.ts` "cookies on https". |
| 3.4.2 | Cookie `HttpOnly` | met | Same tests. |
| 3.4.3 | Cookie `SameSite` | met | `SameSite=Lax`, same tests. |
| 3.4.4 | Cookie `__Host-` prefix | met | `server/src/auth/cookies.ts`; `server/test/units.test.ts` "cookie names carry the __Host- prefix on https only". |
| 3.4.5 | Cookie path | met | `Path=/`, no `Domain` (same tests). |
| 3.5.1 | OAuth tokens and grants revocable | met | Settings → Connected apps; `server/test/oauth.test.ts`, `oauth-hardening.test.ts`. |
| 3.5.2 | Session tokens rather than static API secrets | partial | PATs are static by design (scripts), but scoped, org- and group-constrained, expiring and revocable (ADR 0036/0037). |
| 3.5.3 | Stateless tokens protected | met | No JWT access tokens: OAuth access and refresh tokens are opaque and stored hashed, audience-bound (`server/src/auth/oauth-bearer.ts`, ADR 0045). |
| 3.7.1 | Re-authentication before sensitive operations | partial | Account, token, org-admin and admin routes require the browser session (`requireBrowserSession`, 11 §2.1); there is no step-up re-authentication with the IdP. |

## V4 Access control

| ID | Requirement (short) | Status | Evidence |
|---|---|---|---|
| 4.1.1 | Enforced on a trusted server | met | Services (hard rule 1); `server/test/authz.matrix.test.ts`. |
| 4.1.2 | Access attributes not manipulable by users | met | Actor resolved from the session or token only (`server/src/auth/actor.ts`); the admin role from `ROOSTER_ADMIN_EMAILS` with a verified email, checked on every request (`server/test/admin-capability.test.ts`). |
| 4.1.3 | Least privilege | met | Grant scopes and org/group constraints (ADR 0036/0037), `admin` capability only for admins (ADR 0041 §7). |
| 4.1.5 | Access control fails securely | met | Unknown or unreadable resources are `404`, missing scopes `403` (`authz.matrix.test.ts`). |
| 4.2.1 | IDOR protection | met | Every route × every actor kind in `authz.matrix.test.ts`; outsiders get `404`. |
| 4.2.2 | CSRF protection | met | Origin check for cookie-authenticated unsafe requests and JSON-only bodies (`server/src/lib/csrf.ts`; `server/test/units.test.ts` "rejects a cookie-authenticated mutation from another origin or without Origin"). |
| 4.3.1 | Admin interfaces use MFA | partial | Delegated to the IdP (MFA is configured there); rooster cannot see whether it was used. |
| 4.3.2 | No directory browsing or metadata files | met | `server/src/lib/web-app.ts` never serves `*.map` or dot-paths (`server/test/web-app.test.ts`); the image ships no source maps (`docker/Dockerfile`, WP 11.4). |
| 4.3.3 | Extra checks for high-value actions | partial | OAuth apps need an explicit "Allow deleting tasks" consent and scope step-up on `/mcp` (ADR 0042/0043); org deletion needs the name typed (`confirm_name_mismatch`). |
| — | PAT scope enforcement (10 §6) | met | `authz.matrix.test.ts` (read-only, group-constrained, other-org, expired, revoked PATs), `server/test/grants.test.ts`, `grant-hardening.test.ts`. |

## V5 Validation, sanitisation and encoding

| ID | Requirement (short) | Status | Evidence |
|---|---|---|---|
| 5.1.1 | HTTP parameter pollution | met | zod-openapi validates params, query and body per route (`server/src/routes/*`). |
| 5.1.3 | Positive input validation | met | Shared zod schemas (`packages/core/src/schemas`); `422 validation_failed` (`server/test/app.test.ts`). |
| 5.1.4 | Structured data strongly typed | met | Same; dates are `YYYY-MM-DD` strings, ids UUIDv7, RRULE subset (`packages/core/src/recurrence.ts`). |
| 5.1.5 | Redirects only to allowed destinations | met | `web/src/lib/safe-redirect.ts` (`safeRedirectPath`); better-auth callback URLs are relative; the CLI opens only https URLs on the profile's origin (`cli/src/launch.ts`, ADR 0039). |
| 5.2.1 | Untrusted HTML sanitised | met | No user HTML is rendered: comments use a Markdown-light AST (`packages/core/src/comment-markdown.ts`), descriptions Tiptap with a Markdown converter (`web/src/features/editor/markdown.ts`). |
| 5.2.5 | Template injection | met | Emails are React templates rendered on the server (`server/src/mail/templates`), user text as text nodes. |
| 5.2.6 | SSRF | met | Push endpoints re-checked on every send (`server/src/push/endpoint.ts`, ADR 0033; `server/test/delivery-security.test.ts`); Client ID Metadata Documents fetched DNS-pinned to public addresses (`server/src/auth/cimd-fetch.ts`; `server/test/cimd-fetch.test.ts`); S3 requests only to `ROOSTER_S3_ENDPOINT`. |
| 5.2.7 | Scriptable SVG | met | SVG is never shown inline: downloads are `attachment` with `default-src 'none'; sandbox` and `nosniff` (`server/src/routes/attachments.ts`, ADR 0049 §3.5; `server/test/attachments.test.ts`). |
| 5.3.1 | Context-aware output encoding | met | React escapes; the TUI and CLI strip control and bidi characters (`cli/src/output/format.ts`). |
| 5.3.3 | XSS protection | met | Strict CSP without inline script (`server/src/lib/security-headers.ts`; `server/test/app.test.ts` "sets the strict CSP"), no `dangerouslySetInnerHTML` of user content (its one use is the user guide, HTML built from the repo at build time; ADR 0052 §2). |
| 5.3.4 | SQL injection | met | Drizzle parameterised queries; FTS queries built from parsed terms (`packages/core/src/search.ts` `toFtsMatch`; `server/test/search.test.ts`). |
| 5.3.8 | OS command injection | met | No shell anywhere: the server spawns nothing; the CLI uses argv only (`cli/src/launch.ts`). |
| 5.3.9 | Local/remote file inclusion | met | Backup names match `BACKUP_NAME_REGEX` (`server/src/services/backup-service.ts`); blob keys validated (`server/src/blob/keys.ts`); the CLI writes files only through `safe-write.ts` (ADR 0044). |
| 5.5.1–5.5.3 | Safe deserialisation | met | JSON only, parsed then validated by zod; no XML, no object deserialisation. |

## V7 Error handling and logging

| ID | Requirement (short) | Status | Evidence |
|---|---|---|---|
| 7.1.1 | No credentials or tokens in logs | met | Invite tokens, iCal tokens and pending device user codes redacted in the request log (`server/src/lib/request-log.ts`); PATs and OAuth tokens never logged. |
| 7.1.2 | No other sensitive data in logs | met | `logSafeError` drops SQL parameters (`server/src/lib/log-safe-error.ts`; `server/test/log-safe-error.test.ts`, `server/test/security.test.ts`); upload refusals log types and size only. Admin → System shows job errors scrubbed the same way (`server/src/jobs/job-board.ts`). |
| 7.1.3 | Security-relevant events logged | partial | Every request is logged with status, user and request id (`request-log.ts`), so failed authorisation (401/403) and rate limits (429) are visible; sign-in refusals are logged by better-auth. No dedicated security-event stream. |
| 7.1.4 | Enough detail to investigate | met | JSON lines with time, request id, method, path, status, user id (`request-log.ts`). |
| 7.3.1 | Log injection | met | pino JSON encoding. |
| 7.3.3, 7.3.4 | Log storage protection, time sync | n/a | Logs go to stdout; storage and clocks are the host's (08 §9). |
| 7.4.1 | Generic error messages | met | problem+json with stable codes; unexpected errors are `500 internal_error` without detail (`server/src/lib/errors.ts`; `server/test/security.test.ts` "problem+json never contains stacks", `server/test/app.test.ts`). |
| 7.4.2, 7.4.3 | Consistent exception handling, last-resort handler | met | One error handler for the app (`createErrorHandler`); the scheduler catches job failures (`server/src/jobs/scheduler.ts`). |

## V8 Data protection

| ID | Requirement (short) | Status | Evidence |
|---|---|---|---|
| 8.1.1 | Sensitive data protected from caching in server components | met | No shared caches in the server; per-user responses are not cached. |
| 8.1.2 | Cached or temporary copies protected | met | Upload temp files in `<data>/tmp` (0700), removed after each upload and at boot (`server/src/main.ts`); files 0600 via umask 0077; a restored database is made 0600 at boot (`server/src/db/boot.ts`; `server/test/db.test.ts`). |
| 8.2.1 | Anti-caching headers on sensitive responses | met | `Cache-Control: no-store` on every `/api/v1` response without its own policy (`server/src/lib/security-headers.ts` `noStoreApi`; `server/test/security.test.ts`); downloads `private, no-cache` with access-checked `304` (ADR 0049). |
| 8.2.2 | Data in browser storage | met | Per-user keys through `userStorageKey()` (`web/src/lib/user-storage.ts`); IndexedDB cache and outbox tied to the user (ADR 0017). |
| 8.2.3 | Browser data cleared after the session ends | met | `clearLocalData()` on sign-out, 401 and user switch (`web/src/data/sync/engine.ts`, ADR 0051). |
| 8.3.1 | Sensitive data in bodies or headers, not query strings | met | Except the calendar-feed capability URL (see 3.1.1). |
| 8.3.2 | Users can export and remove their data | partial | Org export as JSON/Markdown (`server/src/services/export-service.ts`), tasks, comments and attachments can be deleted, orgs too. There is no self-service account deletion (an admin deactivates; see [Gaps](#gaps)). |
| 8.3.4 | Sensitive data identified, with a policy | partial | See 1.8.1. |
| 8.3.7 | Encryption of sensitive data at rest | n/a | Operator's choice (disk or volume encryption; S3 server-side encryption); rooster does not encrypt the SQLite file. |

## V9 Communications

| ID | Requirement (short) | Status | Evidence |
|---|---|---|---|
| 9.1.1 | TLS for all client connections | partial | Terminated at the reverse proxy (08 §5, `docker/proxy/`); rooster sends HSTS (hono `secureHeaders`) and `__Host-` cookies on https. Plain http is possible behind a proxy or for local development. |
| 9.2.1 | Outbound connections use TLS | partial | Push services and Google are https. `smtp://`, `http://` S3 endpoints and http OIDC discovery URLs are accepted for self-hosted setups (MinIO, local IdPs); the operator chooses. |

## V10 Malicious code

| ID | Requirement (short) | Status | Evidence |
|---|---|---|---|
| 10.2.1 | No unauthorised phone-home | met | No telemetry (08 §10); better-auth telemetry off (`auth.ts`); no CDN fonts or scripts. |
| 10.3.2 | Code and dependency integrity | partial | Lockfile, base images pinned by digest (`docker/Dockerfile`, ADR 0017), Dependabot; images are not signed. |

## V11 Business logic

| ID | Requirement (short) | Status | Evidence |
|---|---|---|---|
| 11.1.2 | Realistic per-user limits | met | 600 API requests per minute per user (`rate-limit.ts`), per-grant limit on `/mcp` (ADR 0043), at most 100 attachments per task, 5 reminders, 10 calendar feeds, and the per-user storage quota (ADR 0052 §6; `server/test/storage-quota.test.ts`). |
| 11.1.4 | Anti-automation | met | As 2.2.1 and 11.1.2. |
| 11.1.5 | Business-logic limits | met | Subtask depth, idempotency keys (`server/test/sync-middleware.test.ts`), refresh-token reuse revocation (ADR 0045). |

## V12 Files and resources

| ID | Requirement (short) | Status | Evidence |
|---|---|---|---|
| 12.1.1 | Large files refused | met | `ROOSTER_UPLOAD_MAX_MB`, streamed and cut off (`server/src/blob/multipart.ts`; `server/test/attachments.test.ts`, `multipart.test.ts`); JSON bodies 1 MB, auth 64 KB (`server/src/lib/body-limit.ts`). |
| 12.1.2 | Compressed files and decompression bombs | met | Archives are stored, never unpacked; images are decoded with a pixel limit (`server/src/blob/content.ts` `limitInputPixels`). |
| 12.1.3 | Per-user storage quota | met | `ROOSTER_USER_STORAGE_MB`, `413 storage_quota_exceeded`, checked inside the recording transaction (`server/src/services/attachment-service.ts`; `server/test/storage-quota.test.ts`, incl. concurrency and Trash). |
| 12.2.1 | Files validated by content | met | Type sniffed from the bytes; a spoofed image type is `415 mime_mismatch` (`server/src/blob/content.ts`; `server/test/attachments.test.ts`, `avatars.test.ts`). The backup drill uploads an image through the Docker image (`scripts/backup-drill.sh`). |
| 12.3.1, 12.3.2 | User file names never used for paths | met | Blob keys are `<org>/<attachment id>` (`server/src/blob/keys.ts`); names are cleaned for display and `Content-Disposition` only (`cleanFilename`, `contentDisposition`). |
| 12.4.1 | Uploads stored outside the web root | met | `<data>/attachments` or S3; the web root is the build (`server/src/lib/web-app.ts`). |
| 12.4.2 | Uploaded files scanned for malware | gap | See [Gaps](#gaps). |
| 12.5.1 | Only intended file types served | met | `web-app.ts` serves the build without `*.map` and dot-paths. |
| 12.5.2 | Uploads never executed as HTML/JS | met | `Content-Disposition: attachment` (inline only for raster images), `nosniff`, `default-src 'none'; sandbox` (ADR 0049 §3.5). |
| 12.6.1 | Outbound requests to allowlisted destinations | met | See 5.2.6. |

## V13 API and web services

| ID | Requirement (short) | Status | Evidence |
|---|---|---|---|
| 13.1.1 | Same encodings and parsers everywhere | met | One JSON parser and zod validation per route. |
| 13.1.3 | No sensitive data in API URLs | met | Except the calendar-feed capability URL (3.1.1), whose token is redacted in the request log. |
| 13.1.4 | Authorisation at URI and resource level | met | Route-level credential kinds (OpenAPI security) plus service checks; `authz.matrix.test.ts`. |
| 13.1.5 | Unexpected content types rejected | met | `415 unsupported_media_type` for non-JSON unsafe requests (`server/src/lib/csrf.ts`); uploads require multipart. |
| 13.2.1 | Only intended HTTP methods | met | Unknown routes and methods are problem+json `404`/`405`; contract test (`server/test/contract.test.ts`). |
| 13.2.2 | JSON schema validation | met | zod on every body; responses checked against the OpenAPI document in e2e (AC-8.4). |
| 13.2.3 | CSRF on cookie-based REST | met | See 4.2.2. |
| 13.2.6 | Trustworthy headers | met | `X-Forwarded-For` honoured only with `ROOSTER_TRUST_PROXY`, right-most hop (`server/src/lib/client-ip.ts`, ADR 0017). |
| 13.2.5 | Content type checked | met | See 13.1.5. |

## V14 Configuration

| ID | Requirement (short) | Status | Evidence |
|---|---|---|---|
| 14.1.1 | Automated, repeatable builds | met | `scripts/ci.sh`, `docker/Dockerfile`, `.github/workflows/release.yml`. |
| 14.1.3 | Hardened server configuration | met | Distroless, non-root, read-only app files; config validated at boot, exit 78 (`server/src/config.ts`). |
| 14.2.1 | Components up to date, checked | met | `pnpm audit --prod --audit-level high` in CI (ADR 0052 §5), Dependabot. |
| 14.2.2 | Unneeded features removed | met | Prometheus `/metrics` dropped (ADR 0052 §9); only one platform's native binaries and no source maps in the image (`docker/Dockerfile`, WP 11.4). |
| 14.2.3 | SRI for external assets | n/a | No external assets (08 §10). |
| 14.2.4 | Components from trusted sources | met | npm registry with lockfile; images pinned by digest. |
| 14.2.5 | Software bill of materials | gap | See [Gaps](#gaps). |
| 14.3.2 | Debug modes off in production | met | `NODE_ENV=production`; response validation is test-only (`ROOSTER_VALIDATE_RESPONSES`). |
| 14.3.3 | No version disclosure in headers | met | No `Server`/`X-Powered-By`; the version is in `GET /api/v1/meta` on purpose (clients compare it for updates). |
| 14.4.1 | Content-Type with charset | met | JSON and problem+json from the framework; text downloads `text/plain; charset=utf-8`. |
| 14.4.2 | `Content-Disposition` on downloads | met | Attachments, backups, exports (`attachments.ts`, `admin.ts`, `export.ts`). |
| 14.4.3 | Content-Security-Policy | met | Strict CSP on every response (`security-headers.ts`; `server/test/app.test.ts`). |
| 14.4.4 | `X-Content-Type-Options: nosniff` | met | hono `secureHeaders` on every response. |
| 14.4.5 | HSTS | met | hono `secureHeaders` default. |
| 14.4.6 | Referrer-Policy | met | `same-origin` (`security-headers.ts`). |
| 14.4.7 | Framing restricted | met | `frame-ancestors 'none'`, `X-Frame-Options`. |
| 14.5.2 | Origin not used for authentication | met | Origin only rejects cross-site requests (CSRF), never grants access. |
| 14.5.3 | CORS allowlist | met | No CORS headers at all: the API is same-origin; the MCP endpoint validates `Origin` (ADR 0043). |
| 14.5.4 | Proxy-added headers trusted only when configured | met | See 13.2.6. |

## Gaps

Found in the Phase 11 pass and accepted for 1.5.0 (ADR 0054 §10). All five are still open and
on the backlog (09 §Backlog, "Security hardening"); none is scheduled.

1. **12.4.2 Malware scanning of uploads.** No antivirus. Uploads are never executed or rendered
   by rooster (12.5.2), so the risk is a member passing a file to another member. Accepted for
   a self-hosted, invite-only app. An operator who needs scanning can scan the attachment
   storage (`/data/attachments` or the S3 bucket) outside rooster.
2. **8.3.2 Self-service account deletion.** Users can delete their content and leave orgs, but
   cannot delete their account; an admin can only deactivate it (`PATCH /admin/users/{id}`).
   Options: an admin "delete user" with reassignment of their tasks, or a documented manual
   removal.
3. **14.2.5 SBOM.** No SBOM is published with the image (`release.yml` builds without
   `--sbom`). Option: `docker buildx build --sbom=true` in `release.yml`.
4. **3.3.2 / 3.7.1 Re-authentication.** Sessions live 30 days and are renewed while used;
   sensitive operations do not ask the IdP again. Accepted: the IdP's own session policy
   applies at each sign-in. Option: an absolute session lifetime setting.
5. **1.1.2 / 1.8.1 Threat model and data classification** exist only implicitly: the trust
   boundaries of the security audit (`docs/security/security-review.md`, 09 Phase 11) and 04 §4.11.
   Option: a short data classification in `docs/security/`.

## Fixed in this pass

- **Uploads failed in the Docker image since 1.4.0** (12.2.1): `file-type`'s `fileTypeFromFile`
  imports `strtok3` through a computed specifier that the bundled server cannot resolve, so every
  attachment and avatar upload answered `500` in the image (tests ran from source and passed).
  Sniffing now reads a file-backed `Blob` (`server/src/blob/content.ts`); the backup drill
  uploads an image through the built image, so CI catches this class of bundling bug.
- **8.2.1** `Cache-Control: no-store` on API responses.
- **8.1.2** a restored database file is made owner-only at boot.
- **12.1.3** the per-user storage quota.
