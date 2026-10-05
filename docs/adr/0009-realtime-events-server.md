# ADR 0009: Realtime events (server side, Phase 4)

- Status: accepted
- Date: 2026-10-05
- Refines: 04 §4.5; contract `packages/core/src/schemas/events.ts`

## Decisions
1. **Publish after commit only.** Domain events go into a per-transaction queue inside the services' `immediate()` transaction wrapper. Rolled-back work publishes nothing.
2. **Audiences are explicit user IDs**, worked out inside the transaction. The hub keeps no org subscriptions, so a membership change applies from the next event onward.
   - **Task changes:** the actor, plus every user holding a placement on the task, its ancestors or its descendants, receive `my-list`. All members receive `task:<id>` for the whole family, plus `trash` on delete, restore or purge. A re-parent or purge also notifies those who could see the task before.
   - **Moves, expansion and groups** go to the owner only. A group delete or restore that deletes or restores tasks adds the task audiences.
   - **Tags** go to all members: `tags`, `my-list`, and `task` for retagged tasks.
   - **Membership:**
     - The affected user receives `orgs` and `me`.
     - Members receive `org-members`.
     - Owners receive `org-invites`.
     - Tasks unassigned on removal notify their audiences.
3. **`origin`** is the request's `X-Rooster-Client-Id`, carried per request through AsyncLocalStorage.
4. **Coalescing:** keys are merged per stream for 50 ms, bucketed by (org, origin). Above 64 keys, repeated prefixes collapse (for example to `['task']`).
5. **Stream lifecycle:**
   - Every frame has a process-wide monotonic `id:`.
   - A `: ping` heartbeat goes out every 25 s and also re-checks the session.
   - Streams close on sign-out (the better-auth `session.delete.after` hook), session revoke, user disable and graceful shutdown. During shutdown, new streams get `503 unavailable`.
6. **Last-write-wins clocks:**
   - Group delete and restore use the clock key `deleted`.
   - A tag's `task_tag.added_at` is the edit time.
   - Expansion has no clock and ignores the edit time.
7. **Replays:** replaying a create with the same client ID and content returns the existing entity (200/201) without an `Idempotency-Key`, and publishes no event.
8. **Offline tag conflicts:** `409 tag_name_taken` (on create and rename) carries `existingId` in the problem body, so the outbox can remap a client-created tag ID.
9. **Clock skew:** `GET /api/v1/meta` includes `serverTime` (`Cache-Control: no-store`).

## Known gaps
- The retention purge job publishes no events. Clients see purged items disappear on their next refetch.
- Allowlist and backups changes send no invalidations; those admin screens are online-only.
- A client that stops reading its stream can delay shutdown until the grace timeout.
