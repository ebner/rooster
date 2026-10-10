import type { ApiError } from './errors';

/**
 * Session signals for state that lives outside the query cache, so the sync engine's cleanup
 * and the router's 401 handling reach it without import cycles (the router imports every route).
 */

type Listener<T> = (value: T) => void;

const ended = new Set<Listener<void>>();
/** Counts the wipes, so a request can tell that its session's data went while it was out. */
let epoch = 0;
const unauthenticated = new Set<Listener<ApiError>>();

function subscribe<T>(set: Set<Listener<T>>, listener: Listener<T>): () => void {
  set.add(listener);
  return () => set.delete(listener);
}

/**
 * The local data of the signed-in user is being dropped: sign-out, a lost session, or another
 * account on this browser. Anything held for that user (files, drafts) must go too.
 */
export const onSessionDataCleared = (listener: () => void) => subscribe(ended, listener);

/** Called by the sync engine wherever it wipes the cache. */
export function sessionDataCleared(): void {
  epoch += 1;
  for (const listener of ended) listener();
}

/**
 * Ties one request to the current session: `abort` runs when the session's data is cleared
 * first, and `stale()` tells a late answer not to touch the caches (they may be the next
 * account's by then). Call `done()` when the request settles.
 */
export function sessionScope(abort?: () => void): { stale: () => boolean; done: () => void } {
  const started = epoch;
  const done = abort ? onSessionDataCleared(abort) : () => {};
  return { stale: () => epoch !== started, done };
}

/** A request outside TanStack Query (XHR uploads) answered 401. */
export const onUnauthenticatedRequest = (listener: Listener<ApiError>) =>
  subscribe(unauthenticated, listener);

/** Hands a 401 from outside TanStack Query to the router's sign-in redirect (AC-1.7). */
export function reportUnauthenticated(error: ApiError): void {
  for (const listener of unauthenticated) listener(error);
}
