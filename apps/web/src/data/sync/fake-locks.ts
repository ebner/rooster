import type { LockManagerLike } from './leader';

interface Request {
  callback: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/**
 * A Web Locks stand-in for tests: one holder (a single lock name), waiters in order, `steal`
 * and `signal`, like `navigator.locks` across the tabs of an origin.
 */
export function fakeLocks(): LockManagerLike & { holders(): number } {
  let holder: Request | null = null;
  const queue: Request[] = [];
  const grant = () => {
    if (holder) return;
    const next = queue.shift();
    if (!next) return;
    holder = next;
    // Like the browser, the callback runs in a later task, never inside `request()`.
    void Promise.resolve()
      .then(next.callback)
      .then((value) => {
        // A stolen lock's callback may still settle later: it no longer releases anything.
        if (holder !== next) return;
        holder = null;
        next.resolve(value);
        grant();
      });
  };
  return {
    holders: () => (holder ? 1 : 0),
    request: (_name, options, callback) =>
      new Promise((resolve, reject) => {
        const request: Request = { callback, resolve, reject };
        if (options.steal) {
          holder?.reject(new DOMException('The lock was stolen', 'AbortError'));
          holder = null;
          queue.unshift(request);
          grant();
          return;
        }
        options.signal?.addEventListener('abort', () => {
          const index = queue.indexOf(request);
          if (index < 0) return;
          queue.splice(index, 1);
          reject(new DOMException('Aborted', 'AbortError'));
        });
        queue.push(request);
        grant();
      }),
  };
}
