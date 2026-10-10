import { Cron } from 'croner';
import { logSafeError } from '../lib/log-safe-error.ts';
import type { Logger } from '../lib/logger.ts';
import type { JobBoard } from './job-board.ts';

export type JobFn = () => void | Promise<void>;

export interface Scheduler {
  /** Registers a cron job. Names are unique; overlapping runs of the same job are skipped. */
  register(name: string, pattern: string, fn: JobFn): void;
  /** Job names in registration order. */
  jobs(): string[];
  /** Runs a registered job now, outside its schedule (errors are logged, not thrown). */
  run(name: string): Promise<void>;
  stop(): void;
}

/**
 * `board` (Admin → System) records each job's last run; `clock` stamps them (ms epoch).
 */
export function createScheduler(
  logger: Logger,
  options: { board?: JobBoard; clock?: () => number } = {},
): Scheduler {
  const { board, clock = Date.now } = options;
  const jobs = new Map<string, Cron>();
  return {
    register(name, pattern, fn) {
      if (jobs.has(name)) throw new Error(`job "${name}" is already registered`);
      const log = logger.child({ job: name });
      // No croner `name`: that registers the job in croner's process-global list.
      const protect = () => log.warn('previous run still busy; skipped');
      board?.register(name);
      const job = new Cron(pattern, { protect }, async () => {
        const start = performance.now();
        const startedAt = clock();
        try {
          await fn();
          log.debug({ ms: Math.round(performance.now() - start) }, 'job finished');
          board?.finished(name, startedAt);
        } catch (err) {
          log.error({ err: logSafeError(err) }, 'job failed');
          board?.finished(name, startedAt, err);
        }
      });
      jobs.set(name, job);
    },
    jobs: () => [...jobs.keys()],
    async run(name) {
      const job = jobs.get(name);
      if (job === undefined) throw new Error(`job "${name}" is not registered`);
      await job.trigger();
    },
    stop() {
      for (const job of jobs.values()) job.stop();
      jobs.clear();
    },
  };
}
