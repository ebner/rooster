# ADR 0002: Own organisation tables instead of better-auth's organization plugin

- Status: accepted
- Date: 2026-10-05
- Supersedes part of: D-33, 04 §2 (auth row), 04 §4.4, 05 §2

## Context
better-auth's `organization` plugin registers its own HTTP endpoints under `/api/auth/organization/*`: create, invite, accept, set role, remove member, delete. Those endpoints would bypass rooster's `OrgService`, and with it:
- **Hard rule 1:** authorisation lives only in services.
- **The personal-org rules:** single member, no invites, not deletable.
- **Bootstrapping each new member's Inbox and default groups.**
- **The last-owner rule, and removing a member's groups and placements.**

Hooks could re-enforce some of this, but the endpoints would remain a second, partially guarded write path.

## Decision
- better-auth is used for **authentication only**: users, sessions, accounts, verification, social and generic OIDC, and later (P8) device authorisation, bearer and API keys.
- `organization`, `member` and `invitation` (email invites) are **rooster-owned Drizzle tables**. Their columns match 05 §2, including the additional fields. They are managed exclusively through `OrgService` and the `/api/v1` routes in 06 §2.2.
- Link invites use `invite_link` (05 §3), as before.

## Consequences
- There is one write path for orgs, fully covered by the authorisation matrix test.
- better-auth's `session.activeOrganizationId` is not used. The current org is part of the URL (`/o/:slug/...`).
- If better-auth's organisation features are wanted later (for example teams), this ADR must be revisited.
