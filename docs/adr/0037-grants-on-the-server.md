# ADR 0037: Grants, PATs and the device flow on the server (Phase 8)

- Status: accepted
- Date: 2026-10-09
- Amends: 05 (`session.grant_id`, `deviceCode` columns, `access_grant.created_by_grant_id`), 06 §2.1 (`/api/auth` is browser-only, device routes under `/api/v1`), 07 §4 (`token create` from the CLI)
- Code: `apps/server/src/auth/{auth,actor,mount}.ts`, `src/services/{grant-access,grant-service}.ts`, `src/routes/{grants,refs,schemas-grants}.ts`, migration `0007_agent_access`

## Decisions
1. **A task's group is where it shows in the user's list:** its own placement, or else its nearest placed ancestor's. A subtask of mine under someone else's task in Prio counts as Prio. Root-only would put that row outside every group even though the user sees it in Prio.
2. **Check order.**
   1. Org not reached, or target not readable: `404`.
   2. Missing scope: `403 forbidden_scope`.
   3. Outside the constraints: `403 outside_grant`, whose `detail` names the allowed groups.

   Lists, search, my-list, the views, activity and the SSE stream are filtered silently. Settings, org administration, invites, export, admin and push are browser-session only.
3. **`/api/auth/*` is browser-cookie only.**
   - A middleware in front of better-auth answers `403` to any `Authorization` or API-key credential. It does the same for a cookie that resolves to a device session.
   - The two exceptions are `/device/code` and `/device/token`, which run unauthenticated with credentials stripped.
   - The `set-auth-token` response header that better-auth's `bearer` plugin adds is removed, because it exposed the httpOnly browser token to scripts.
   - The test enumerates every mounted better-auth endpoint.
4. **The session kind follows the transport.** A session with a grant works only as `Authorization: Bearer`, and a session without one only as the cookie. Each mismatch is `401`, so a leaked browser token can't be replayed as an unconstrained bearer.
5. **Device approval** uses better-auth's `deviceAuthorization` with rooster's own review, approve and deny routes. better-auth's `/device`, `/device/approve` and `/device/deny` are disabled.
   - Approval writes the grant and marks the code approved.
   - On redemption, the plugin's `assertSessionRedemption` hands the grant ID to `databaseHooks.session.create.before`, which writes `session.grant_id`.
   - A missing or dead grant means no session.
   - A device request without `scope` asks for everything, and approval may narrow it but not widen it.
   - `/device/token` accepts form-encoded bodies (RFC 8628) as well as JSON.
6. **PATs** are rows in the api-key plugin's table, minted in the same transaction as their grant and looked up by hash (read-only) per request. The grant's `last_used` is written at most once a minute. The plugin's own HTTP endpoints are disabled, and the grant's expiry governs.
7. **The CLI can create PATs** (07 §4) from a device session, never from a PAT. The new grant must be a subset of the creator's: scopes, constraints (`isNarrowing`) and expiry. It records `created_by_grant_id` and outlives the device.
8. **Notifications for a grant** cover only the orgs it reaches, and so does the unread count, over SSE too. SSE drops invalidations for unreached orgs and sends `notification` events only with `notifications:read`. Editing or revoking a grant closes its streams.
9. **Activity** records `via: 'pat'` for PAT writes, the client kind (`cli`, `tui`, `mcp`) for device writes, and the `grantId` in the activity data.
10. **Task refs** resolve server-side (`GET /tasks/resolve`), within the grant's read constraints. Seven or fewer bare digits are a seq; eight or more hex digits are an ID prefix.
