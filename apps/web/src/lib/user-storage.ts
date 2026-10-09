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
  try {
    if (!storage) return;
    const keep = keepUserId === undefined ? null : userStorageKey(keepUserId, '');
    const doomed: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key === null) continue;
      if (key.startsWith(userStoragePrefix) && (keep === null || !key.startsWith(keep))) {
        doomed.push(key);
      } else if (legacyUserPrefixes.some((prefix) => key.startsWith(prefix))) {
        doomed.push(key);
      }
    }
    for (const key of doomed) storage.removeItem(key);
    if (doomed.some((key) => pushMarkerPattern.test(key))) void unsubscribe();
  } catch {
    // Private mode or blocked storage.
  }
}
