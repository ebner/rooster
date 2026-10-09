# ADR 0038: The permissions editor, device approval and Connected apps (Phase 8)

- Status: accepted
- Date: 2026-10-09
- Amends: 11 §3 (UX), FR-SET-3
- Code: `apps/web/src/features/access/*`, `src/data/{grants,device}.ts`, `src/routes/device.tsx`

## Decisions
1. **One `ConstraintEditor`** serves the new-token form, the `/device` approval and grant editing now, and Phase 9's OAuth consent screen later.
   - It takes an optional `ceiling`. In narrow-only mode every option is checked against it with `isNarrowing`, and the expiry can't be extended.
   - Step-up scopes are marked "New".
2. **Connected apps is a section of Settings → Security** (`/settings/security#connected-apps`), next to the signed-in browsers (FR-SET-3).
3. **`/device` is a centred consent page outside the app frame.** Signed out, it redirects to login and comes back through `safeRedirectPath`. It accepts `?user_code=` or a typed code, and shows one message for a wrong, expired or used code (the server answers `404` for all three).
4. **"All organisations"** is an explicit checkbox meaning `orgs: "all"`, which includes orgs joined later. Otherwise each org has Read (Everything / Only these groups) and Change (Nothing / Everything / Only these groups).
5. **Defaults.**
   - A new token: `tasks:read`, the current orgs listed (not "all"), write nothing, 90 days.
   - A device: the requested scopes everywhere, never expiring.
   - The first write scope on a grant that writes nowhere starts with the personal org's Inbox.
6. **Writing implies reading:** a write group joins a limited read list, and removing a read group removes it from the write list.
7. **Summaries never understate.** They list every capability from the expanded scopes, leaving out only "See tasks" when another listed capability includes it.
