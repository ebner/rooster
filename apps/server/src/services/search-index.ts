import { mentionsToPlain } from '@rooster/core/mentions';
import { sql } from 'drizzle-orm';
import type { Tx } from './context.ts';

// Below SQLite's default host-parameter limit; list-access has its own copy (no import cycle).
const CHUNK = 500;

/**
 * `task_fts` maintenance (05 §3, 04 §4.7, ADR 0013). The index holds exactly one row per
 * non-deleted task (whatever its org's state; search filters by live membership), with its
 * live comments in the `comments` column (mentions as `@Name`, so user IDs are never
 * indexed). Every task write that changes the title, the description or `deleted_at`, and
 * every comment write, calls `indexTasks` in the same transaction, which is simpler to test
 * than SQL triggers.
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
    const rows = tx.all<{ id: string; org_id: string; title: string; description: string }>(
      sql`SELECT id, org_id, title, description FROM task
        WHERE id IN (${list}) AND deleted_at IS NULL`,
    );
    if (rows.length === 0) continue;
    const comments = new Map<string, string[]>();
    for (const c of tx.all<{ task_id: string; body: string }>(
      sql`SELECT task_id, body FROM comment
        WHERE task_id IN (${list}) AND deleted_at IS NULL
        ORDER BY created_at, id`,
    )) {
      const bodies = comments.get(c.task_id) ?? [];
      bodies.push(mentionsToPlain(c.body));
      comments.set(c.task_id, bodies);
    }
    for (const r of rows) {
      const text = (comments.get(r.id) ?? []).join('\n');
      tx.run(sql`INSERT INTO task_fts (task_id, org_id, title, description, comments)
        VALUES (${r.id}, ${r.org_id}, ${r.title}, ${r.description}, ${text})`);
    }
  }
}

/** Drops rows whose task is gone or deleted (after hard deletes that cascaded). */
export function pruneIndex(tx: Tx): number {
  return tx.run(sql`DELETE FROM task_fts WHERE task_id NOT IN
    (SELECT id FROM task WHERE deleted_at IS NULL)`).changes;
}

/** Rebuilds the whole index from the task and comment tables; returns the indexed tasks. */
export function rebuildIndex(tx: Tx): number {
  tx.run(sql`DELETE FROM task_fts`);
  const ids = tx
    .all<{ id: string }>(sql`SELECT id FROM task WHERE deleted_at IS NULL ORDER BY id`)
    .map((r) => r.id);
  indexTasks(tx, ids);
  return ids.length;
}

/** Whether the index row count differs from the number of non-deleted tasks. */
export function indexIsStale(tx: Tx): { indexed: number; expected: number; stale: boolean } {
  const indexed = tx.get<{ n: number }>(sql`SELECT count(*) AS n FROM task_fts`)?.n ?? 0;
  const expected =
    tx.get<{ n: number }>(sql`SELECT count(*) AS n FROM task WHERE deleted_at IS NULL`)?.n ?? 0;
  return { indexed, expected, stale: indexed !== expected };
}
