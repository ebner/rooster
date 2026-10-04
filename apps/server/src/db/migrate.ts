import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { AppDb } from './client.ts';

const MIGRATIONS_TABLE = '__drizzle_migrations';

/**
 * Migrations live next to the running module: `src/db/migrations` under tsx/vitest, and
 * `dist/migrations` in the bundle (tsdown copies the folder there, see tsdown.config.ts).
 */
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

function assertMigrationsDir(dir: string): void {
  if (!existsSync(join(dir, 'meta', '_journal.json'))) {
    throw new Error(`Migrations folder not found or incomplete: ${dir}`);
  }
}

/** Mirrors drizzle's rule: a migration is pending if it is newer than the last applied one. */
export function hasPendingMigrations(db: AppDb, dir: string = MIGRATIONS_DIR): boolean {
  assertMigrationsDir(dir);
  const migrations = readMigrationFiles({ migrationsFolder: dir });
  if (migrations.length === 0) return false;
  const table = db.sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(MIGRATIONS_TABLE);
  if (table === undefined) return true;
  const row = db.sqlite
    .prepare(`SELECT MAX(created_at) AS last FROM ${MIGRATIONS_TABLE}`)
    .get() as { last: number | string | null };
  const last = row.last === null ? -1 : Number(row.last);
  return migrations.some((m) => m.folderMillis > last);
}

export function runMigrations(db: AppDb, dir: string = MIGRATIONS_DIR): void {
  assertMigrationsDir(dir);
  migrate(db.orm, { migrationsFolder: dir, migrationsTable: MIGRATIONS_TABLE });
}

/** Consistent online snapshot via `VACUUM INTO`; the destination must not exist yet. */
export function backupDatabase(db: AppDb, destPath: string): void {
  db.sqlite.prepare('VACUUM INTO ?').run(destPath);
}
