# ADR 0036: One grant model for PATs, CLI devices and OAuth clients

- Status: accepted
- Date: 2026-10-09
- Amends: 04 §4.3–4.4, 06 §1 and §2.1, 07 §2 and §4 (per 11-agent-access)
- Code: `packages/core/src/grants.ts`, `packages/core/src/schemas/grants.ts`, `apps/cli` (skeleton)

## Context
Phase 8 introduces PATs and CLI device logins; Phase 9 adds OAuth clients and remote MCP. Separate permission models per credential would mean two enforcement paths and a migration in Phase 9.

## Decisions
1. **One `access_grant` per credential** (`kind`: `pat`, `device`, `oauth`), built in Phase 8 with the `oauth` kind and `client_id` already present. Phase 9 adds a way to obtain a grant, not a new model.
2. **The grant holds the permission.** A PAT (better-auth `apiKey`) and a device session only point at their grant (`grantId`). Permissions are never stored only in plugin metadata.
3. **Scopes are OAuth scope strings from the start** (`tasks:read`, `tasks:write`, `comments:write`, `tasks:assign`, `groups:write`, `tasks:delete`, `notifications:read`), with implications (`expandScopes`). PAT scopes, device scopes and Phase 9's OAuth `scope` and `scopes_supported` are the same strings. The PAT flag `--read-only` remains as an alias for `tasks:read`.
4. **Constraints and their evaluation are pure core code** (`canRead`, `canWrite`, `canWriteOrg`, `grantsOrg`, `isNarrowing`). The server enforces with them in services (`authorizeGrant`), the web previews with them, and the CLI explains denials with them. A task's group is the grant user's placement (for a subtask, its root's); a task not in the user's list counts as outside every group list.
5. **One consent and constraint editor** in the web serves the `/device` approval page and the new-token form now, and Phase 9's OAuth consent screen later.
6. **Device approval goes through rooster routes** (`GET /device/:userCode`, `POST /device/:userCode/approve`) that wrap better-auth's device authorization, so the approval can carry scopes and constraints. The resulting bearer session is linked to its grant.
7. **Narrowing only for OAuth grants** (`isNarrowing`); PATs and devices may be edited freely by their owner.
