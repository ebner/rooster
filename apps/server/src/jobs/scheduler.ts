import { Cron } from 'croner';
import type { Logger } from '../lib/logger.ts';

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

export function createScheduler(logger: Logger): Scheduler {
  const jobs = new Map<string, Cron>();
  return {
    register(name, pattern, fn) {
      if (jobs.has(name)) throw new Error(`job "${name}" is already registered`);
      const log = logger.child({ job: name });
      // No croner `name`: that registers the job in croner's process-global list.
      const protect = () => log.warn('previous run still busy; skipped');
      const job = new Cron(pattern, { protect }, async () => {
        const start = performance.now();
        try {
          await fn();
          log.debug({ ms: Math.round(performance.now() - start) }, 'job finished');
        } catch (err) {
          log.error({ err }, 'job failed');
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
