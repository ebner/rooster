import type { Config } from '../config.ts';
import type { AppDb } from '../db/client.ts';
import type { Services } from '../services/index.ts';
import type { Scheduler } from './scheduler.ts';

export interface JobDeps {
  db: AppDb;
  /** Without services only the maintenance pragma runs (used by low-level tests). */
  services?: Pick<Services, 'retention' | 'backups' | 'push' | 'mail'> &
    Partial<Pick<Services, 'reminders' | 'blobGc'>>;
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
  // P10 jobs (tasks): task reminders (ADR 0049 §2.3). Every due reminder is claimed
  // before it is sent, so overlapping runs, restarts and instances on the same database never
  // fire one twice. Also run once at boot, so reminders missed while down go out at once.
  const { reminders } = services;
  if (reminders !== undefined) {
    scheduler.register('task-reminders', '* * * * *', async () => {
      await reminders.runDue();
    });
    void scheduler.run('task-reminders');
  }
  // P10 jobs (files): blob GC (ADR 0049 §3.6). Deletes the blobs the attachment trigger
  // queued (deletes, purges); failures stay queued for the next run. Also run once at boot.
  const { blobGc } = services;
  if (blobGc !== undefined) {
    scheduler.register('blob-gc', '* * * * *', async () => {
      await blobGc.drain();
    });
    void scheduler.run('blob-gc');
  }
  const cron = config?.backup.cron ?? null;
  if (cron !== null) {
    scheduler.register('backup', cron, () => {
      services.backups.runScheduled();
    });
  }
}
