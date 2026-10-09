import { addDays, dueInstant, type IsoDate, todayIn } from '@rooster/core/dates';
import { and, eq, gte, lt, max, ne } from 'drizzle-orm';
import { jobRun } from '../db/schema/index.ts';
import type { Tx } from './context.ts';

/**
 * How long after a user's local send time (reminder, digest) the per-minute job still sends
 * it. A restart, a slow boot or a stalled minute must not lose the day's send (AC-7.1); the
 * `job_run` claim keeps it to one per day.
 */
export const SEND_GRACE_MS = 10 * 60_000;

/** `job_run` rows are kept this long (the digest reads the previous run's time). */
export const JOB_RUN_RETENTION_MS = 30 * 86_400_000;

/**
 * The local date whose `time` (HH:MM in `tz`) is due at `now`: due from that instant until
 * the grace window ends. Yesterday is checked too, for a send time just before midnight.
 * A time skipped by a DST jump fires at the shifted instant, and a repeated one at its first
 * occurrence (`dueInstant`).
 */
export function dueSlot(now: number, tz: string, time: string, graceMs = SEND_GRACE_MS) {
  const today = todayIn(tz, now);
  for (const date of [today, addDays(today, -1)]) {
    const at = dueInstant(date, time, tz);
    if (now >= at && now < at + graceMs) return { date, at };
  }
  return null;
}

export function jobScope(userId: string, date: IsoDate): string {
  return `${userId}|${date}`;
}

/**
 * Claims `(job, scope)` before a send: true for the first caller only. Claim first, then send:
 * a crash in between loses that send rather than repeating it.
 */
export function claimJobRun(tx: Tx, job: string, scope: string, now: number): boolean {
  return (
    tx.insert(jobRun).values({ job, scope, ranAt: now }).onConflictDoNothing().run().changes === 1
  );
}

/** When `job` last ran for the user, other than for `exceptScope` (e.g. today's claim). */
export function lastUserRun(
  tx: Tx,
  job: string,
  userId: string,
  exceptScope: string,
): number | null {
  // `|` sorts below `}`, so the range covers exactly the scopes `<userId>|…` (PK prefix).
  const row = tx
    .select({ at: max(jobRun.ranAt) })
    .from(jobRun)
    .where(
      and(
        eq(jobRun.job, job),
        gte(jobRun.scope, `${userId}|`),
        lt(jobRun.scope, `${userId}}`),
        ne(jobRun.scope, exceptScope),
      ),
    )
    .get();
  return row?.at ?? null;
}

/** Retention: claims older than 30 days. */
export function purgeJobRuns(tx: Tx, now: number): number {
  return tx
    .delete(jobRun)
    .where(lt(jobRun.ranAt, now - JOB_RUN_RETENTION_MS))
    .run().changes;
}
