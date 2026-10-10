# ADR 0051: An account change in a running page reloads it

- Status: accepted
- Date: 2026-10-10
- Amends: ADR 0017 (account switch on a shared browser), ADR 0019 (cross-tab clear)

## Context
The session cookie is shared by every tab. When someone signs in as another account in one tab, the other tabs used to learn about it in one of two ways: the `cleared` broadcast, which reloads them, or their next `/me`. On `/me` they only wiped the query cache and the outbox, and the page kept running.

A security review (after the Phase 10 upload fixes) showed that the page's continuations outlive such a wipe. They then act for the next account, or show the previous one's data to it:
- mutation callbacks and rollbacks writing `/me` or the inbox;
- a list fetch writing the pipeline's confirmed base;
- push registration finishing after the switch;
- a calendar feed URL, a PAT or an invite link being revealed;
- OAuth consent continuing to the redirect;
- comment drafts and the undo stack.

Guarding each of these one by one would never be complete.

## Decision
- **A page that has run as one account reloads when `/me` names another.** The engine remembers the account the page ran as (`ranAs`; unlike `userId`, it survives a lost session). Before anything awaits, `closeSession()` does all of the following synchronously:
  - stops saving, the SSE stream and the list pipeline;
  - clears TanStack's mutation cache;
  - emits `sessionDataCleared()`.

  After that, the page reloads. The tab that signed in has normally wiped the shared outbox and cache already. This page wipes them only when the browser's owner is still the old account, so ops the new account queued in the meantime are kept.
- **The cross-tab `cleared` message** runs the same synchronous `closeSession()` before it suspends the persister and reloads.
- **State outside the query cache subscribes to `data/session-events.ts`** (`onSessionDataCleared`): the upload queue, comment drafts and the undo stack. A request that outlives its session takes a `sessionScope()` and drops a late answer (avatars).
- **The first `/me` after another account owned the browser** also drops this browser's push subscription. The new user has no marker, so any subscription here is someone else's, even one whose registration was still in flight.

## Amendment after the re-check (the barrier)
The reload alone left a window between detecting the switch and unloading the page. During that window callbacks still ran, a channel `ping` could reconcile the shared outbox with the old account's view, and a fire-and-forget push cleanup could be cut off by the reload. So:
- **`closeSessionForGood()`** (in `data/session-events.ts`) latches the page closed. From then on, `api`, through openapi-fetch middleware, and `sendMultipart` refuse every request with `session_closed`, and an XHR answer that arrives later is rejected instead of resolved. Continuations may still run until the page unloads, but they reach neither the server nor the persisted cache.
- **`closeSession()`** also calls the engine's `stop()`. This means no more saves or SSE, the page stops listening on the channel, and it releases leadership.
- **The account the page ran as** includes the restored cache: `ranAs` is taken from the restored `/me` before the first fresh one arrives.
- **Order of the switch:** when this tab is the first to see the new account, the push unsubscription and the wipe finish before the owner changes and the page reloads.
- **Loop guard:** a tab reloads at most once per account (`sessionStorage` `rooster.reloadedAs`). If its stored data cannot be dropped, it wipes in place instead.

## Amendment after the second re-check
- **The pipeline closes for good** (`ListPipeline.close()`): ops enqueued after the switch are refused, so an editor flushing on unmount stores and announces nothing.
- **better-auth requests** check the latch (`fetchOptions.onRequest`). Sign-out checks it again after its push cleanup, so it can't sign the next account out. A consent decision that finishes after the latch doesn't navigate to the client's redirect URI.
- **The shared outbox is wiped by owner:** a takeover keeps the new account's records (`wipe({ keepUser })`). A slower tab of the old account re-reads the owner after its push cleanup and leaves the wipe to the tab that took over.
- **The reload guard** is spent on the next confirmed `/me` that needs no reload. A page that already reloaded once for the account and still holds the old account's data wipes it in place.

## Consequences
- In-flight continuations die with the page, so stale writes, revealed secrets and replayed undo can't cross accounts.
- **Remaining window:** requests already sent before a tab learns of the switch carry the new cookie. This is inherent to cookie sessions shared by tabs. The `cleared` broadcast from the tab that signed in usually closes the window within about a second of its boot.
- A tab switching accounts reloads once. That is rare, and it is the same thing a cross-tab sign-out already did.
