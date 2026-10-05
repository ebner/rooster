# ADR 0003: Phase 1 auth and org details

- Status: accepted
- Date: 2026-10-05
- Refines: 04 §4.4 (allowlist), 05 §2 (slugs), 06 §2.2 (invites)

## Decisions
1. **Returning invitees.** An existing user who is a member of at least one live (not deleted) shared org may sign in even if no allowlist rule matches. This is allowlist rule 6. Otherwise a user who joined through a now-consumed invite could never sign in again.
2. **Personal org slug** is `personal-` + the **last** 8 hex characters of the user ID. The first 8 hex characters of a UUIDv7 encode the timestamp and collide for users created close together.
3. **Org slugs** are unique among non-deleted orgs. Deleting an org frees its slug.
4. **Email invite tokens** are the invitation ID signed with `ROOSTER_AUTH_SECRET` (HMAC). The better-auth-shaped `invitation` table has no token column.
5. **Invite claim endpoint.** `POST /api/v1/invites/{token}/claim` (public) validates an invite and sets the signed, 15-minute `rooster.invite` cookie. The `/invite/:token` page calls it before starting sign-in.
6. **Session cookie** is named exactly `rooster.session`, with no `__Secure-` prefix. `Secure` is set when the base URL is https.
7. **Routes:**
   - Unknown `/api/v1/*` paths return 401 to anonymous callers. Existence is not revealed before authentication.
   - `GET /orgs/{orgId}/invites` is owner-only.
   - Accepting an invite to an org you already belong to is a no-op 200.
8. **Disabled better-auth endpoints:** `/update-user`, `/delete-user` and `/change-email`. Profile changes go through `PATCH /api/v1/me`, so every write passes through rooster's services.
9. **Rejected sign-ins** redirect to `/not-invited?reason=not_invited|account_disabled|unverified_email`. Other OAuth errors redirect to `/login?error=<code>`.
10. **OIDC discovery** happens at boot. A provider whose discovery fails is skipped (and logged) until restart.

## Follow-ups
- The 600 req/min per-user API rate limit (06 §1) is implemented together with idempotency in WP 2.1.
- better-auth's auth-endpoint limiter is per IP. Operators behind a proxy must set `ROOSTER_TRUST_PROXY=true`.
