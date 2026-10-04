import type { AppDb } from '../db/client.ts';
import type { Scheduler } from './scheduler.ts';

/** Registers every in-process job (docs/spec/04-architecture.md §4.6). */
export function registerJobs(scheduler: Scheduler, deps: { db: AppDb }): void {
  scheduler.register('pragma-optimize', '0 4 * * *', () => {
    deps.db.sqlite.pragma('optimize');
  });
}
