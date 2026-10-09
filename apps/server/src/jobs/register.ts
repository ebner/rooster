import type { Config } from '../config.ts';
import type { AppDb } from '../db/client.ts';
import type { Services } from '../services/index.ts';
import type { Scheduler } from './scheduler.ts';

export interface JobDeps {
  db: AppDb;
  /** Without services only the maintenance pragma runs (used by low-level tests). */
  services?: Pick<Services, 'retention' | 'backups' | 'push' | 'mail'>;
  config?: Pick<Config, 'backup'>;
}

/** Registers every in-process job (docs/spec/04-architecture.md §4.6). */
export function registerJobs(scheduler: Scheduler, deps: JobDeps): void {
  scheduler.register('pragma-optimize', '0 4 * * *', () => {
    deps.db.sqlite.pragma('optimize');
  });
  const { services, config } = deps;
  if (services === undefined) return;
  // Trash older than 30 days and idempotency keys older than 7 days (05 §4.5).
  scheduler.register('purge', '30 3 * * *', () => {
    services.retention.purge();
  });
  // P7 (WP 7.3). Each run claims its sends in `job_run`, so overlapping or repeated runs
  // after a restart never send twice; a minute missed during a restart is made up within
  // the grace window (SEND_GRACE_MS).
  scheduler.register('due-reminders', '* * * * *', async () => {
    await services.push.runDueReminders();
  });
  scheduler.register('email-digest', '* * * * *', async () => {
    await services.mail.runDigests();
  });
  scheduler.register('email-batch', '*/5 * * * *', async () => {
    await services.mail.runBatches();
  });
  const cron = config?.backup.cron ?? null;
  if (cron !== null) {
    scheduler.register('backup', cron, () => {
      services.backups.runScheduled();
    });
  }
}
