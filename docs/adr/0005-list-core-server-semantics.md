# ADR 0005: List-core server semantics (Phase 2)

- Status: accepted
- Date: 2026-10-05
- Refines: 05 §4, 06 §1 and §2.3–2.4, 04 §6.2. Contract: `packages/core/src/schemas/list.ts`

## Placement and ordering
1. **Create without intent fields:** the task goes to the top of the Inbox, or to the end of a named group. Explicit `afterId: null, beforeId: null` means the end, per the contract.
2. **Intents are resolved against the server's ordering:**
   - `afterId` alone places the item directly below it.
   - `beforeId` alone places it directly above.
   - With both, the item goes directly below `afterId`. Hidden completed or deleted items may sit in between.
   - A missing or out-of-domain neighbour falls back to the end, and the response reports the actual position.
3. **Split (`splitAfterTaskId`):**
   - Placements below the task, in any state, keep their keys and move to the new group.
   - The new group goes directly after the source group, or first among normal groups when the source is the Inbox.
   - `moved` lists only non-deleted tasks.
4. **Group delete:**
   - Without options, a group that still has open tasks gets `409 group_not_empty`. Completed leftovers move to the end of the Inbox.
   - Soft-deleted placements stay with the deleted group until purge, which re-homes them to the top of the Inbox.
5. **Restore** of a task whose group is gone places it at the top of the Inbox.
6. **The Inbox** can be collapsed, but not renamed, moved or deleted (`409 inbox_immutable`).
7. **Trash** is org-wide: every member sees deleted tasks of the org.
8. **Bulk move:** a task whose position clock is newer than the request's edit time keeps its place and still reports `ok: true` (last write wins is not an error).

## Sync semantics
9. **Idempotency:**
   - `idempotency.response` stores a JSON envelope `{fp, ct, body}`. The fingerprint detects key reuse with a different route or body (`422 idempotency_key_reuse`).
   - 401, 429 and 5xx responses are never stored.
   - Concurrent requests with the same key wait for the first one.
10. **`completed_at`** is the clamped edit time (`X-Rooster-Edit-Time`), not the server's arrival time, so offline completions keep their real time.
11. **`parse: true`** is already live. It uses `findDateInTitle` with the actor's locale, timezone and week start. A trailing `>Group` matches an exact group name first, then a case-insensitive prefix; an unknown group leaves the token in the title. Explicit due fields in the body win over a parsed date.

## Backups (WP 2.9)
12. **Naming:** scheduled snapshots are `rooster-<ts>.db` (taken on a Sunday they count as weekly), and manual ones `manual-<ts>.db`.
13. **At most one scheduled snapshot per UTC day.** A restart checks for an existing file, so no `job_run` table is needed yet.
14. **Rotation:** 7 daily, 4 weekly, and the newest 10 manual and 10 pre-migrate files are kept.

## Known gaps
- If a crash happens between a service commit and its idempotency write, the retry runs again. Creates are protected by the duplicate-ID check, and other ops are LWW-safe.
- `UserService.reorderOrg` still has its own ordering code rather than `OrderingService`. Unify it when touched next.
