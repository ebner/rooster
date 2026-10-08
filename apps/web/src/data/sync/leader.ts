/** The Web Locks name every tab of the origin competes for (04 §6.2). */
export const outboxLockName = 'rooster-outbox';

interface LockOptionsLike {
  steal?: boolean;
  signal?: AbortSignal;
}

export interface LockManagerLike {
  request(
    name: string,
    options: LockOptionsLike,
    callback: () => Promise<unknown>,
  ): Promise<unknown>;
}

export interface Leadership {
  isLeader(): boolean;
  /**
   * Takes the lock from whoever holds it. For a leader that stopped answering: Android freezes
   * a backgrounded tab or PWA without releasing its locks, which would otherwise keep the
   * instance in front from ever sending.
   */
  steal(): void;
  /** Gives the lock up for good (engine stop, tests); another tab takes over. */
  release(): void;
}

export interface LeaderHandlers {
  /** This tab now holds the lock. */
  onLeader: () => void;
  /** Another tab stole the lock; this tab queues for it again. */
  onLost?: () => void;
}

/**
 * Leader election over the Web Locks API: one tab holds `rooster-outbox` and flushes the
 * outbox; when it closes, the browser hands the lock to the next waiting tab. A tab that finds
 * the leader unresponsive steals the lock; the old leader learns it on its next task, follows
 * again and waits in line. Its request still in flight may repeat one the new leader sends,
 * which the Idempotency-Key makes harmless.
 *
 * Without `navigator.locks` (Safari before 15.4, some embedded webviews) every tab flushes on
 * its own. That is safe, only wasteful: the ops carry Idempotency-Keys and the server answers
 * a concurrent repeat with the first request's result.
 */
export function electLeader(
  handlers: LeaderHandlers | (() => void),
  locks: LockManagerLike | undefined = (globalThis.navigator as { locks?: LockManagerLike })?.locks,
  name: string = outboxLockName,
): Leadership {
  const { onLeader, onLost } =
    typeof handlers === 'function' ? { onLeader: handlers, onLost: undefined } : handlers;
  let leader = false;
  if (!locks || typeof locks.request !== 'function') {
    leader = true;
    queueMicrotask(onLeader);
    return { isLeader: () => leader, steal: () => {}, release: () => {} };
  }
  const manager = locks;
  let stopped = false;
  /** Resolves the callback of the lock this tab holds, which releases it. */
  let held: (() => void) | null = null;
  /** The queued request (not granted yet), aborted before a steal or on release. */
  let waiting: AbortController | null = null;

  function request(steal: boolean) {
    // A steal is granted at once and cannot carry a signal (Web Locks spec).
    const controller = steal ? null : new AbortController();
    waiting = controller;
    let granted = false;
    void manager
      .request(name, controller ? { signal: controller.signal } : { steal: true }, () => {
        granted = true;
        if (waiting === controller) waiting = null;
        if (stopped) return Promise.resolve();
        return new Promise<void>((resolve) => {
          leader = true;
          held = () => {
            held = null;
            leader = false;
            resolve();
          };
          onLeader();
        });
      })
      .catch(() => {
        // Aborted while queued (this tab stole or stopped), or torn down with the page.
        if (!granted) return;
        // Stolen: the callback's promise never settles; forget it and queue up again.
        held = null;
        if (leader) {
          leader = false;
          onLost?.();
        }
        if (!stopped && waiting === null) request(false);
      });
  }

  request(false);
  return {
    isLeader: () => leader,
    steal: () => {
      if (leader || stopped) return;
      waiting?.abort();
      waiting = null;
      request(true);
    },
    release: () => {
      stopped = true;
      waiting?.abort();
      waiting = null;
      held?.();
    },
  };
}
