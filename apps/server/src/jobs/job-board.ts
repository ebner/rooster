import type { AdminJobRun } from '@rooster/core/schemas';
import { logSafeError } from '../lib/log-safe-error.ts';

/** Admin → System shows at most this much of a failed run's error. */
const MAX_ERROR_LENGTH = 300;

/**
 * The last run of each scheduled job, in memory (ADR 0052 §7). The scheduler reports into it;
 * `GET /admin/system` reads it. A restart starts empty: jobs show as not run yet until their
 * first run (the last backup is listed separately, from its file).
 */
export class JobBoard {
  private readonly runs = new Map<string, AdminJobRun>();

  /** A job the scheduler now runs; it is listed even before its first run. */
  register(job: string): void {
    if (!this.runs.has(job)) {
      this.runs.set(job, { job, lastRunAt: null, lastStatus: null, lastError: null });
    }
  }

  /** A run that started at `startedAt` ended, with `error` if it threw. */
  finished(job: string, startedAt: number, error?: unknown): void {
    this.runs.set(job, {
      job,
      lastRunAt: startedAt,
      lastStatus: error === undefined ? 'ok' : 'failed',
      // Database errors carry the bound parameters (user content): only the scrubbed first line.
      lastError:
        error === undefined
          ? null
          : (logSafeError(error).message.split('\n')[0] ?? '').slice(0, MAX_ERROR_LENGTH),
    });
  }

  /** Every registered job, in registration order. */
  list(): AdminJobRun[] {
    return [...this.runs.values()].map((run) => ({ ...run }));
  }
}
