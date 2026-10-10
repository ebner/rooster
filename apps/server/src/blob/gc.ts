import { asc, eq } from 'drizzle-orm';
import type { AppDb } from '../db/client.ts';
import { blobGc } from '../db/schema/index.ts';
import { logSafeError } from '../lib/log-safe-error.ts';
import type { Logger } from '../lib/logger.ts';
import type { BlobStores } from './store.ts';

/** Rows deleted per drain pass; the queue is drained pass by pass until a pass frees nothing. */
const BATCH = 100;

export interface GcReport {
  deleted: number;
  /** Still queued after a failed delete (or a backend that is not configured). */
  failed: number;
}

/**
 * The blob GC (ADR 0049 §3.6). The `attachment_blob_gc` trigger queues the keys of every
 * deleted attachment row in `blob_gc`, whatever deleted it (DELETE, a task purge, an org
 * deletion). `drain` deletes the queued blobs and their rows; a failure stays queued for the
 * next run. The minute job calls `drain`, and writes that free blobs `kick` it after commit.
 */
export class BlobGc {
  private running: Promise<GcReport> | null = null;
  private again = false;

  constructor(
    private readonly db: AppDb,
    private readonly stores: BlobStores,
    private readonly logger: Logger,
  ) {}

  /** Starts a drain in the background (never throws). */
  kick(): void {
    void this.drain();
  }

  /**
   * Drains the queue. Concurrent calls share the running pass; one that arrives mid-pass makes
   * it run once more, so keys queued meanwhile are not left for the next minute.
   */
  drain(): Promise<GcReport> {
    if (this.running !== null) {
      this.again = true;
      return this.running;
    }
    this.running = this.loop().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async loop(): Promise<GcReport> {
    const total: GcReport = { deleted: 0, failed: 0 };
    const failedKeys = new Set<string>();
    let firstError: unknown;
    do {
      this.again = false;
      for (;;) {
        const rows = this.db.orm
          .select()
          .from(blobGc)
          .orderBy(asc(blobGc.queuedAt), asc(blobGc.key))
          .limit(BATCH + failedKeys.size)
          .all()
          .filter((r) => !failedKeys.has(r.key));
        if (rows.length === 0) break;
        for (const row of rows) {
          const store = this.stores.byKind(row.storage);
          try {
            if (store === null) throw new Error(`storage backend "${row.storage}" not configured`);
            await store.delete(row.key);
            this.db.orm.delete(blobGc).where(eq(blobGc.key, row.key)).run();
            total.deleted += 1;
          } catch (err) {
            failedKeys.add(row.key);
            total.failed += 1;
            firstError ??= err;
          }
        }
      }
    } while (this.again);
    // One line per pass, not per key: a store that is down would otherwise flood the log.
    if (total.failed > 0) {
      this.logger.warn(
        { err: logSafeError(firstError), failed: total.failed, deleted: total.deleted },
        'blob deletes failed; kept for the next run',
      );
    }
    return total;
  }
}
