# ADR 0056: Decisions from the Phase 11 security audit

- Status: accepted
- Date: 2026-10-10
- Amends: ADR 0017 (account linking), ADR 0037 (grants), ADR 0040 §4 (push key rotation), ADR 0049 (avatars), spec 11 §2.1
- Context: AC-11.1. The findings and their fixes are listed in `docs/security/security-review.md`. This ADR records the decisions that change behaviour or rules.

## Sign-in and identities
1. **An unlinked identity stays blocked until the user allows it again**.
   - `IdentityService.unlink` records the identity in `unlinked_identity`, keyed by provider and subject (migration 0014).
   - better-auth's `account.create.before` hook refuses to create or link a recorded identity. Signing in through it redirects to `/login?error=identity_unlinked`.
   - Settings → Security lists "Removed sign-ins" with "Allow again" (`GET`/`DELETE /me/identities/removed`). The list is a sub-resource, so `GET /me/identities` stays v1-compatible.
2. **`google` is a reserved provider id.** A generic OIDC provider can't use it, and the config refuses it at startup, because Google is an email authority (ADR 0017).
3. **better-auth endpoints rooster doesn't use are disabled:**
   - account linking and unlinking, and `/list-accounts`;
   - token export: `/get-access-token`, `/refresh-token`, `/account-info`;
   - the session endpoints `/list-sessions`, `/get-session` and `/update-session`, which return bearer tokens (including a CLI device's) to page scripts. rooster lists sessions through `/api/v1/me/sessions`, without tokens.
   - ID-token sign-in is refused.

   Every better-auth cookie on https is `__Host-`.

## Consent and device approval
4. **A decision is bound to the session that showed it.**
   - `GET` of a consent or device request returns a `decisionNonce`: an HMAC of the purpose, user, session and request under the auth secret.
   - Allow and deny must send it back, and a mismatch is 404. A stateless nonce survives restarts, and the request's own expiry bounds it.
   - The web re-fetches the request when the session's data is cleared (`useRefetchWhenSessionClears`).
5. **Consent is committed only after the provider issued a genuine code** for the request's redirect URI, and only if the grant didn't change meanwhile (a version check, not a lock). A narrowing or revocation made while the consent was pending wins, and the issued code is withdrawn. One decision per user runs at a time.
6. **A signed `authorization_details` ceiling is enforced in the service (`isNarrowing`).** A ceiling that is malformed or names only orgs or groups that no longer exist makes the request unknown (404) instead of being ignored.
7. **No grant can delete permanently.** Purging from Trash needs a browser session, which keeps the 30-day promise on the consent screen.

## Apps never see colleagues' emails
8. Grant-authorised member lists carry names and ids only (`Member.email` is optional). `GET /orgs/{orgId}/members/resolve?q=<me|email|full name>` resolves an assignee without returning an email:
   - only an exact email, or an exact full name;
   - an unknown email and an unknown name give identical 404s.

   For grants, `@person` in search, task filters and title tokens matches names only. The CLI's `--assign` and MCP's `assignee` resolve through the server.
   - **Accepted:** a caller who already knows an address can confirm it belongs to a member, bounded by the rate limit.
   - **Breaking for older clients:** CLI and MCP 1.3.x and 1.4.x can no longer assign by a bare email local part.

## Push
9. **Rotating the push keys pauses subscriptions instead of deleting them** (supersedes ADR 0040 §4, bullet 3).
   - Nothing is sent with the old keys again. A device renews its subscription with the new key the next time the app opens there. Subscriptions not renewed by the next rotation are deleted then.
   - ADR 0040's invariant holds: a device someone removed never comes back by itself.
10. **At most 20 push devices per user:** a new one evicts the device reached least recently. Endpoints with a URL fragment are refused, because they are aliases of one device.
    - **Accepted:** endpoints that differ only in percent-encoding are not normalised. Normalising them would break real endpoints such as WNS, and the cap bounds the risk.
11. **The delivery queue (`lib/task-queue.ts`) is bounded and fair:**
    - at most 100 jobs per key (`push:<userId>`, `mail:<userId>`) and 2,000 in total;
    - round-robin across keys;
    - a dropped job is logged once per key. A dropped immediate email stays pending for the batch job; a dropped push is not retried.

    Queued digests, due reminders and notification pushes reload the recipient, its access and its preferences when they leave the queue.

## Uploads, avatars and resources
12. **Uploads:**
    - at most 3 in flight per user (`429` with `Retry-After`);
    - every streamed chunk counts against the remaining quota, including uploads stored meanwhile;
    - the transactional quota check stays.
13. **Avatars are stored once per upload,** under `avatars/<userId>.<avatar_id>`, where `avatar_id` is a UUIDv7 (migrations 0013 and 0015). They are read only from the recorded backend, and replaced or removed avatars go to `blob_gc`. **The old "avatars reuse their key" exception is gone for new avatars.**
    - **Accepted:** avatars uploaded with 1.4.x keep the shared-key fallback until they are replaced.
14. **Memory bounds:**
    - request bodies are read into one buffer bounded by the limit (`readBodyBounded`), which the MCP route uses too;
    - SSE writes are bounded at 64 KB of backlog or 30 s without progress, and an evicted socket is destroyed after 2 s;
    - the CIMD fetch closes the connection on bodyless answers.

## Deployment and data
15. **The image:**
    - `/app` is owned by root;
    - boot refuses database files it cannot make owner-only;
    - `.dockerignore` keeps local data directories, SQLite files and `litestream.env` out of build contexts. It doesn't use `**/data`, because `apps/web/src/data` is source.
16. **Litestream credentials** live in `litestream.env` and are read only by the sidecar. `.env` is created with `umask 077`.

## Clients
17. **Web:**
    - on session expiry, pipeline reads and confirmations still in flight are dropped, while the user's outbox is kept;
    - sign-out closes the page's session before wiping, and the `cleared` message names the account, so other tabs delete that account's durable records;
    - a push registration that doesn't complete unsubscribes itself.
18. **CLI:**
    - every diagnostic goes through `safeDiagnostic`, which redacts credentials and strips control characters;
    - bearer tokens are validated before a header is built;
    - TUI background failures are guarded;
    - inline Markdown and mention parsing run in linear time.
