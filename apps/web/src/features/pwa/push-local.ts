/**
 * Drops this browser's push subscription without asking the server: for a session that already
 * ended (401) or another account signing in on a shared browser, where the previous user's
 * notifications must stop at once. The server removes the dead endpoint on its next `404/410`
 * from the push service. Tiny and import-free: `lib/user-storage` calls it from the sweep.
 */
export async function unsubscribeThisBrowser(): Promise<boolean> {
  try {
    const container = globalThis.navigator?.serviceWorker;
    if (!container?.getRegistration) return false;
    const registration = await container.getRegistration();
    const subscription = await registration?.pushManager?.getSubscription();
    return (await subscription?.unsubscribe()) ?? false;
  } catch {
    return false;
  }
}

/** Matches the per-user marker `rooster.user.<id>.pushDevice` (`data/push.ts`). */
export const pushMarkerPattern = /^rooster\.user\.(.+)\.pushDevice$/;
