/** The Web Locks name every tab of the origin competes for (04 §6.2). */
export const outboxLockName = 'rooster-outbox';

interface LockManagerLike {
  request(name: string, callback: () => Promise<unknown>): Promise<unknown>;
}

export interface Leadership {
  isLeader(): boolean;
  /** Gives the lock up (sign-out, tests); another tab takes over. */
  release(): void;
}

/**
 * Leader election over the Web Locks API: exactly one tab holds `rooster-outbox` and flushes
 * the outbox; when it closes, the browser hands the lock to the next waiting tab.
 *
 * Without `navigator.locks` (Safari before 15.4, some embedded webviews) every tab flushes on
 * its own. That is safe, only wasteful: the ops carry Idempotency-Keys and the server answers
 * a concurrent repeat with the first request's result.
 */
export function electLeader(
  onLeader: () => void,
  locks: LockManagerLike | undefined = (globalThis.navigator as { locks?: LockManagerLike })?.locks,
  name: string = outboxLockName,
): Leadership {
  let leader = false;
  let release: (() => void) | null = null;
  if (!locks || typeof locks.request !== 'function') {
    leader = true;
    queueMicrotask(onLeader);
    return { isLeader: () => leader, release: () => {} };
  }
  void locks
    .request(
      name,
      () =>
        new Promise<void>((resolve) => {
          leader = true;
          release = () => {
            leader = false;
            resolve();
          };
          onLeader();
        }),
    )
    .catch(() => {
      // The lock request was aborted (page teardown): nothing to lead.
    });
  return {
    isLeader: () => leader,
    release: () => release?.(),
  };
}
