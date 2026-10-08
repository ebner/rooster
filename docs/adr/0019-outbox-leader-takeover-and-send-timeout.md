# ADR 0019: Outbox leader takeover and send timeout

- Status: accepted
- Date: 2026-10-09
- Amends: ADR 0010 §3 (the single sender)
- Code: `apps/web/src/data/sync/leader.ts`, `engine.ts`, `channel.ts`, `apps/web/src/data/pipeline/pipeline.ts`, `transport.ts`, `http-transport.ts`

## Context

A second cause: a request whose answer was lost (the phone slept or switched network) kept `flush()` waiting forever.

## Decisions
1. **Leader takeover.** One sender is still the normal case, but it is no longer strict. A visible, online follower with a confirmed user and queued ops sends a `ping` once it has heard nothing from the leader for 2 s. If the leader doesn't answer within another 2 s, the follower steals the lock (`navigator.locks.request(..., { steal: true })`). The old leader queues for the lock again. Hidden tabs never steal. A thawed old leader may resend one in-flight op; the Idempotency-Key makes that harmless (ADR 0005).
2. **Who answers a ping.** Only a leader that can send (confirmed `/me`) answers. A leader that cannot send is replaced.
3. **Send timeout.** Every list request times out after 20 s and fails as a transient error (`SendTimeoutError`). It is retried with backoff and the same Idempotency-Key. After three failures the pill shows "Sync problem".
4. **The IndexedDB outbox is the shared source of truth.**
   - It is reconciled by a new leader, by a leader that receives a ping, and by a follower whose leader answered.
   - Ops this tab knew were stored, and that have since left the outbox, are dropped from its queue, followed by a refetch.
   - Ops this tab never heard of are added.
   - Each tab remembers the last 1,000 settled op ids and never queues them again.
5. **Startup messages.** Sync-channel messages are buffered from the moment the engine starts, so a confirmation that arrives during restore is not lost.
6. **Failed merge.** When the request returned 2xx but merging the response fails, the op is not resent; the list is refetched instead.
7. **Testing a frozen page.** E2E simulates it with CDP `Debugger.pause`, because headless Chromium ignores `Page.setWebLifecycleState` on visible pages (`e2e/sync-recovery.mobile.spec.ts`).
