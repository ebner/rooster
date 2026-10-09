import { logSafeError } from './log-safe-error.ts';
import type { Logger } from './logger.ts';

/**
 * Runs async work (push and email sends) outside the request with bounded concurrency. A task
 * never fails its caller: errors are logged through `logSafeError` and the promise resolves
 * to `undefined`.
 */
export class TaskQueue {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly pending = new Set<Promise<unknown>>();

  constructor(
    private readonly concurrency: number,
    private readonly logger: Logger,
  ) {}

  run<T>(name: string, task: () => Promise<T>): Promise<T | undefined> {
    const promise = this.slot()
      .then(task)
      .catch((err: unknown) => {
        this.logger.error({ err: logSafeError(err), task: name }, 'delivery task failed');
        return undefined;
      })
      .finally(() => {
        this.active--;
        this.waiting.shift()?.();
        this.pending.delete(promise);
      });
    this.pending.add(promise);
    return promise;
  }

  private slot(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.active++;
        resolve();
      });
    });
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
