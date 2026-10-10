import { pushMarkerPattern, unsubscribeThisBrowser } from '../features/pwa/push-local';

/**
 * Per-user UI state in localStorage (palette recents, …) lives under one prefix, so a single
 * sweep removes it on sign-out, when the session ends, and when someone else signs in on this
 * browser. Device preferences (theme, sidebar width, language) are not per user and stay.
 */
export const userStoragePrefix = 'rooster.user.';

/** Keys written before 1.0.1, swept the same way. */
const legacyUserPrefixes = ['rooster.palette.recent.'] as const;

/** `rooster.user.<userId>.<name>`. */
export function userStorageKey(userId: string, name: string): string {
  return `${userStoragePrefix}${userId}.${name}`;
}

/**
 * Removes every per-user key, or with `keepUserId` every key of other users. Blocked storage
 * is ignored: then nothing was stored either. Sweeping a push marker (the session ended, or
 * someone else signed in here) also drops this browser's push subscription, so the previous
 * user's notifications stop on a shared browser.
 */
export function sweepUserStorage(
  keepUserId?: string,
  storage: Storage | undefined = globalThis.localStorage,
  unsubscribe: () => Promise<unknown> = unsubscribeThisBrowser,
): void {
  const keep = keepUserId === undefined ? null : userStorageKey(keepUserId, '');
  sweep(
    (key) =>
      (key.startsWith(userStoragePrefix) && (keep === null || !key.startsWith(keep))) ||
      legacyUserPrefixes.some((prefix) => key.startsWith(prefix)),
    storage,
    unsubscribe,
  );
}

/**
 * Removes one account's keys only (its session ended in another tab): a tab may have written
 * them after that tab's sweep. Every other account's keys stay.
 */
export function sweepUserStorageOf(
  userId: string,
  storage: Storage | undefined = globalThis.localStorage,
  unsubscribe: () => Promise<unknown> = unsubscribeThisBrowser,
): void {
  const prefix = userStorageKey(userId, '');
  sweep((key) => key.startsWith(prefix), storage, unsubscribe);
}

function sweep(
  doomedKey: (key: string) => boolean,
  storage: Storage | undefined,
  unsubscribe: () => Promise<unknown>,
): void {
  try {
    if (!storage) return;
    const doomed: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key !== null && doomedKey(key)) doomed.push(key);
    }
    for (const key of doomed) storage.removeItem(key);
    if (doomed.some((key) => pushMarkerPattern.test(key))) void unsubscribe();
  } catch {
    // Private mode or blocked storage.
  }
}
