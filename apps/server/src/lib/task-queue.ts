import { logSafeError } from './log-safe-error.ts';
import type { Logger } from './logger.ts';

/** Admission limits: jobs queued or running, per key and in all. */
export interface TaskQueueLimits {
  perKey: number;
  total: number;
}

/**
 * Delivery work one key (a user and channel, e.g. `push:<userId>`) may have queued or
 * running, and the whole queue. A user with many devices and a burst of notifications must
 * not hold thousands of jobs ahead of everyone else (ASVS 11.1.2); what does not fit is
 * dropped and logged. A dropped email stays pending and goes out with the next batch.
 */
export const DELIVERY_LIMITS: TaskQueueLimits = { perKey: 100, total: 2_000 };

/**
 * Runs async work (push and email sends) outside the request with bounded concurrency. A task
 * never fails its caller: errors are logged through `logSafeError` and the promise resolves
 * to `undefined`, as it does for a task the limits drop.
 *
 * Waiting tasks are taken round-robin across keys, so one key's backlog delays every other
 * key by at most one task per turn.
 */
export class TaskQueue {
  private active = 0;
  /** Waiting starts per key; the map's order is the round-robin rotation. */
  private readonly waiting = new Map<string, (() => void)[]>();
  private readonly pending = new Set<Promise<unknown>>();
  /** Jobs queued or running per key. */
  private readonly counts = new Map<string, number>();
  /** Keys (and `*` for the whole queue) whose drops were already logged since they last emptied. */
  private readonly dropping = new Set<string>();

  constructor(
    private readonly concurrency: number,
    private readonly logger: Logger,
    private readonly limits: TaskQueueLimits = DELIVERY_LIMITS,
  ) {}

  run<T>(name: string, task: () => Promise<T>, key = ''): Promise<T | undefined> {
    const count = this.counts.get(key) ?? 0;
    if (count >= this.limits.perKey || this.pending.size >= this.limits.total) {
      this.dropped(name, key, count >= this.limits.perKey ? key : '*');
      return Promise.resolve(undefined);
    }
    this.counts.set(key, count + 1);
    const promise = this.slot(key)
      .then(task)
      .catch((err: unknown) => {
        this.logger.error({ err: logSafeError(err), task: name }, 'delivery task failed');
        return undefined;
      })
      .finally(() => {
        this.active--;
        this.release(key);
        this.next();
        this.pending.delete(promise);
        if (this.pending.size === 0) this.dropping.delete('*');
      });
    this.pending.add(promise);
    return promise;
  }

  /** Logged once per key (or once for a full queue) until it has emptied again. */
  private dropped(name: string, key: string, reason: string): void {
    if (this.dropping.has(reason)) return;
    this.dropping.add(reason);
    this.logger.warn(
      { task: name, key, queued: this.pending.size, limits: this.limits },
      reason === '*' ? 'delivery queue full; tasks dropped' : 'delivery tasks dropped for one key',
    );
  }

  private release(key: string): void {
    const left = (this.counts.get(key) ?? 1) - 1;
    if (left > 0) {
      this.counts.set(key, left);
      return;
    }
    this.counts.delete(key);
    this.dropping.delete(key);
  }

  private slot(key: string): Promise<void> {
    if (this.active < this.concurrency) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const list = this.waiting.get(key);
      const start = () => {
        this.active++;
        resolve();
      };
      if (list === undefined) this.waiting.set(key, [start]);
      else list.push(start);
    });
  }

  /** Starts the next waiting task of the next key in turn; that key moves to the back. */
  private next(): void {
    const first = this.waiting.entries().next();
    if (first.done === true) return;
    const [key, list] = first.value;
    const start = list.shift();
    this.waiting.delete(key);
    if (list.length > 0) this.waiting.set(key, list);
    start?.();
  }

  /** Resolves once every queued and running task, including ones they queue, has finished. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  /** Like `idle`, but gives up after `timeoutMs`; false when work was still running. */
  async drain(timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const done = this.idle().then(() => true as const);
    const result = await Promise.race([done, timeout]);
    clearTimeout(timer);
    return result;
  }
}
