# ADR 0017: Security hardening (1.0.1)

- Status: accepted
- Date: 2026-10-08
- Context: a security audit after the 1.0.0 release (four focused reviews plus an independent review). No cross-org or cross-user data path was found. This ADR records the hardening decisions taken from it.
- Refines: 04 §4.3, §4.4, §4.11, §6; 08 §3, §5; ADRs 0003, 0005, 0009, 0010, 0013, 0014

## Sign-in
1. **Account linking.** Linking a new provider identity to an existing account by email, whether implicit or through `/link-social`, is allowed only for email-authority providers: Google, and generic providers with `trustEmail: true` in `ROOSTER_OIDC_PROVIDERS`. Other providers get `account_link_blocked` (`/not-invited?reason=account_link_blocked`). They can still sign in new users and their own returning users.
2. **Single-use link invites** are accepted atomically in `session.create.before`. A sign-in that fails to accept the invite must be admitted on its own, or it is refused with no session.
3. **Cookies.** On https the session and invite cookies are `__Host-rooster.session` and `__Host-rooster.invite`. Plain http (dev, e2e) keeps the old names. The rename signs every user out once.
4. **Weak secrets.** The server refuses to start (exit 78) when `ROOSTER_AUTH_SECRET` contains `change-me` or has fewer than 10 distinct characters. The brief asked for 16, but that would reject about 23 % of `openssl rand -hex 32` secrets. `.env.example` ships no secret.

## Requests
5. **Client IP.** The client IP is the Nth `X-Forwarded-For` entry from the right, where N = `ROOSTER_TRUSTED_PROXY_HOPS` (default 1). With fewer entries, the socket address is used. Proxies must not pass a client-supplied chain on (08 §5).
6. **Body limits** are enforced in the app, including chunked bodies: 64 KB on `/api/auth/*` and 1 MB on `/api/v1/*`, answered with `413 payload_too_large`, so they don't depend on a reverse proxy's body limit, which may not apply to proxied or chunked bodies. Upload routes (Phase 10) get their own larger, route-level limit.
7. **CSRF.** The Origin check is skipped only for actors that authenticated with a bearer token or a PAT (from Phase 8), never because an `Authorization` header is present.

## Realtime and data
8. **SSE** allows at most 4 streams per session and 12 per user; opening one more closes the oldest. The `origin` (client id) is sent only to the actor's own streams.
9. **Idempotency.** When a user loses access to an org, through removal or org deletion, all of that user's stored idempotency responses are deleted. The rows aren't kept per org.
10. **Search** examines at most 5,000 candidates for a filtered query, and its reads run in a DEFERRED transaction.
11. **Retention** also purges expired better-auth `verification` rows.
12. **Files.** The process runs with umask 0077, and the data, backup and attachment directories are created 0700. Existing paths are not re-chmod-ed (operators: `chmod 700 data data/backups`, `chmod 600 data/*.db*`).

## Logs and static files
13. **Logs** never contain invite tokens (paths are logged as `/api/v1/invites/:token…`), FTS query text, or bound SQL parameters (`logSafeError`).
14. **Static serving** never returns `*.map` files or dot-paths, not even as the SPA shell. The web build uses `sourcemap: 'hidden'`.

## Client
15. **Per-user localStorage** lives under `rooster.user.<id>.` (`lib/user-storage.ts`). It is swept on sign-out, on a 401, and when a different user signs in. Device preferences are kept.
16. **Revocation.** Every fresh `/me` prunes the cached lists, tags, task details and searches of orgs no longer in `me.orgs`, together with their queued ops. Offline search covers only current orgs.
17. **Outbox records carry their `userId`.** Records of any other user are dropped and never sent. `reset()` cancels pending writes, so a queued op can no longer reappear in IndexedDB after sign-out.
18. **Persisted cache expiry.** The persisted cache is restored only when the last server-confirmed `/me` is less than 30 days old (the session lifetime). Otherwise it is deleted.
19. **Description links** allow only http, https, mailto and relative hrefs. Entity-encoded schemes are refused, and refused links keep their text.
20. **Redirects.** `safeRedirectPath` rejects any result that starts with `//` or contains `\`.

## Supply chain
21. CI actions are pinned to commit SHAs, with CI permissions `contents: read`. The Docker base images are pinned by digest. Dependabot (`.github/dependabot.yml`) bumps both weekly.

## Not done
- A user row created by the losing side of the invite race stays: it is inert, with no session. AC-1.1's "no user row" therefore doesn't hold in that edge case.
- Signing in on a lost device while offline still shows its cache for up to 30 days. This is inherent to offline support (D-32).
- `409 id_conflict` still shows whether a client-chosen UUIDv7 is in use anywhere. This is not practical to exploit.
