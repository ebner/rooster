import { sql } from 'drizzle-orm';
import type { Tx } from './context.ts';

// Below SQLite's default host-parameter limit; list-access has its own copy (no import cycle).
const CHUNK = 500;

/**
 * `task_fts` maintenance (05 §3, 04 §4.7). The index holds exactly one row per non-deleted
 * task (whatever its org's state; search filters by live membership). Every task write that
 * changes the title, the description or `deleted_at` calls `indexTasks` in the same
 * transaction, which is simpler to test than SQL triggers. `comments` stays empty until
 * comments arrive (Phase 6).
 */
export function indexTasks(tx: Tx, taskIds: readonly string[]): void {
  const unique = [...new Set(taskIds)];
  for (let i = 0; i < unique.length; i += CHUNK) {
    const ids = unique.slice(i, i + CHUNK);
    const list = sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    );
    tx.run(sql`DELETE FROM task_fts WHERE task_id IN (${list})`);
    tx.run(sql`INSERT INTO task_fts (task_id, org_id, title, description, comments)
      SELECT id, org_id, title, description, '' FROM task
      WHERE id IN (${list}) AND deleted_at IS NULL`);
  }
}

/** Drops rows whose task is gone or deleted (after hard deletes that cascaded). */
export function pruneIndex(tx: Tx): number {
  return tx.run(sql`DELETE FROM task_fts WHERE task_id NOT IN
    (SELECT id FROM task WHERE deleted_at IS NULL)`).changes;
}

/** Rebuilds the whole index from the task table; returns the number of indexed tasks. */
export function rebuildIndex(tx: Tx): number {
  tx.run(sql`DELETE FROM task_fts`);
  return tx.run(sql`INSERT INTO task_fts (task_id, org_id, title, description, comments)
    SELECT id, org_id, title, description, '' FROM task WHERE deleted_at IS NULL`).changes;
}

/** Whether the index row count differs from the number of non-deleted tasks. */
export function indexIsStale(tx: Tx): { indexed: number; expected: number; stale: boolean } {
  const indexed = tx.get<{ n: number }>(sql`SELECT count(*) AS n FROM task_fts`)?.n ?? 0;
  const expected =
    tx.get<{ n: number }>(sql`SELECT count(*) AS n FROM task WHERE deleted_at IS NULL`)?.n ?? 0;
  return { indexed, expected, stale: indexed !== expected };
}
