# ADR 0010: Offline sync and PWA client (Phase 4)

- Status: accepted
- Date: 2026-10-05
- Refines: 04 §5–§6; ADR 0009 (server events)

## Decisions
1. **Startup:** `startSync()` (`apps/web/src/data/sync/engine.ts`) runs before the first render. It restores the persisted cache and the outbox, then replays queued ops on top.
   - The cache stores the last **server-confirmed** list per org, not the optimistic one, so a replay never applies an op twice.
   - The IndexedDB key is `rooster-cache-v1`, kept for 30 days, with the app version as the buster.
2. **Cache contents:** `me`, `my-list` for every org (all orgs are prefetched, not just visited ones), `tags`, the 200 most-recent task details, and the first page of notifications.
   - Persisted queries use `gcTime: Infinity`; a 30-day timer would overflow and free them at once.
   - Restored queries are marked **stale** at startup, so they render instantly and refetch as soon as the app is online.
3. **Outbox:** every op is written to IndexedDB **before** it is sent.
   - Exactly one tab holds the Web Lock `rooster-outbox` and is the only sender.
   - Other tabs mirror its queue, confirmations, drops and status over `BroadcastChannel('rooster')`.
   - Without Web Locks every tab sends; idempotency keys keep that safe.
4. **Identity:**
   - Sending waits for a fresh `/me`, and the cache owner's user ID is stored in localStorage.
   - A different user signing in wipes the cache and the outbox in every tab, and sign-out clears both.
   - An online **401** on `/me` removes all cached data except a reset `/me` and deletes the persisted cache; the route guard then redirects to `/login`. The outbox is **kept** for that user ID and flushes after the same user signs in again.
5. **Errors:**
   - `409 tag_name_taken` with `existingId` remaps the pending client tag ID (falling back to a lookup by name).
   - Offline time does not count as failures, and 401 pauses sending.
6. **Sync pill:** "Syncing…" appears only after 600 ms, or right after reconnecting, and offline outranks "Sync problem". One component (`features/pwa/sync-status.tsx`) is used in the desktop and mobile headers.
7. **SSE client:**
   - Reconnects with backoff, and retries a missing endpoint only every 5 minutes.
   - Pauses after the tab has been hidden for 5 minutes.
   - Skips self-originated invalidations unless edits are still queued.
   - A server version or build different from the bundle triggers a service-worker update check.
8. **Service worker:** a custom `src/sw.ts` (injectManifest).
   - It never caches `/api`, and serves the app shell for navigations except `/api`, `/ical` and `/_dev`.
   - It activates only when the page asks. The page waits for an empty outbox and no focused editor first.
   - The update toast stays up for up to 24 h.
   - Push handlers are stubs until P7.
9. **Persister:** a custom throttled persister replaces `@tanstack/query-async-storage-persister`, so sign-out can cancel a pending save.
10. **E2E setup:**
    - `*.pwa.spec.ts` run against `vite build`, served by a second API server (strict CSP, no Vite proxy).
    - `*.pwa-last.spec.ts` (AC-4.7) runs last and rewrites `dist/sw.js`, because Playwright cannot intercept service-worker script fetches.
    - Two full e2e suites must not run at the same time, because the ports are shared.

## Known gaps
- A confirmation that lands less than a second before the tab closes may be missing from the persisted cache on an offline start, until the next fetch.
