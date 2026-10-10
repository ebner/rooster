import type { ApiError } from './errors';

/**
 * Session signals for state that lives outside the query cache, so the sync engine's cleanup
 * and the router's 401 handling reach it without import cycles (the router imports every route).
 */

type Listener<T> = (value: T) => void;

const ended = new Set<Listener<void>>();
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
  for (const listener of ended) listener();
}

/** A request outside TanStack Query (XHR uploads) answered 401. */
export const onUnauthenticatedRequest = (listener: Listener<ApiError>) =>
  subscribe(unauthenticated, listener);

/** Hands a 401 from outside TanStack Query to the router's sign-in redirect (AC-1.7). */
export function reportUnauthenticated(error: ApiError): void {
  for (const listener of unauthenticated) listener(error);
}
