# ADR 0019: Outbox leader takeover and send timeout

- Status: accepted
- Date: 2026-10-09
- Amends: ADR 0010 §3 (the single sender)
- Code: `apps/web/src/data/sync/leader.ts`, `engine.ts`, `channel.ts`, `apps/web/src/data/pipeline/pipeline.ts`, `transport.ts`, `http-transport.ts`

## Context
On Android, the installed app could show "Syncing…" indefinitely. The installed PWA and a Chrome tab on the same origin share the Web Lock `rooster-outbox`, the IndexedDB outbox and the BroadcastChannel. Android freezes a background page without releasing its locks. The frozen tab stayed leader, and the visible app's edits were never sent until the Chrome tab was closed.

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

## Amendment (2026-10-19): bounded outbox waits
8. **Every wait for the outbox has a deadline (4 s).** On Android, the app could show "Syncing…" while nothing reached the server for days, and a task created meanwhile could be lost. Each send waited for the IndexedDB write chain (write-ahead) without limit, so a browser whose IndexedDB stopped answering held every op in memory until the page closed. Now:
   - each outbox write may take 4 s; after that it no longer holds the chain, and the queue is marked stalled. Its IndexedDB request is already placed, so later writes still land after it;
   - a send waits for the writes at most 4 s, and not at all while the outbox is stalled: an op that only lives in memory is safest once it is sent. The Idempotency-Key covers a write that lands late and is replayed after a reload;
   - a follower's `enqueued` message goes out after the timeout with `stored: false`, so the leader still learns of and sends the op;
   - `syncWithOutbox` gives up on a read after 4 s (`StorageTimeoutError`) and leaves the queue as it is; a write still unanswered is not in `stored`, so its op never counts as settled;
   - when the start-up read misses the 3 s restore wait, its records still join the queue (through `restore`) when it answers;
   - the tag lookup after a `409 tag_name_taken` without `existingId` is bounded like a send.

## Amendment (2026-10-19, later): a leader that answers but makes no progress
9. **§8 did not cover every case.** After 1.7.1 an Android phone could still show "Syncing…" and send nothing while every read succeeded, also after the installed app was killed and restarted. The cause on such a device is unconfirmed. The remaining hole in the design: a follower takes over only from a leader that does not answer, and a leader whose flush hangs answers every ping (§2). Such a leader can outlive a restart of the app in front, for instance a Chrome tab on the same origin still running an older version that hung on IndexedDB. Now the watch also tracks the op at the head of the follower's queue. When the leader answers, but the same op has stayed at the head for 45 s (`leaderProgressMs`) while the leader reports no failure and no expired session, the follower steals the lock. A healthy leader can't stay that long on one op without reporting a failure: a send times out after 20 s and its storage wait after 4 s, and both count as failures. A leader in a 429 wait (no failure counted) may lose the lock needlessly; the new leader then waits the same way, so the only cost is a repeated request with the same Idempotency-Key.
