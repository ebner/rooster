import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../lib/logger.ts';
import { type AppDb, openDb } from './client.ts';
import { ensureInstanceId, readLastBootVersion, recordBootVersion } from './instance.ts';
import { backupDatabase, hasPendingMigrations, MIGRATIONS_DIR, runMigrations } from './migrate.ts';

/**
 * Data, backup and attachment directories are private to the server's user: they hold the
 * whole database. Files inside inherit the process umask (0o077, set in main.ts).
 */
export const PRIVATE_DIR_MODE = 0o700;

export interface DataPaths {
  dataDir: string;
  dbFile: string;
  backupsDir: string;
  attachmentsDir: string;
}

export function dataPaths(dataDir: string): DataPaths {
  return {
    dataDir,
    dbFile: join(dataDir, 'rooster.db'),
    backupsDir: join(dataDir, 'backups'),
    attachmentsDir: join(dataDir, 'attachments'),
  };
}

function timestampForFile(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

/** Database files hold every user's data: owner-only, whatever made them. */
export const PRIVATE_FILE_MODE = 0o600;

/**
 * A restored database (a copied snapshot, `litestream restore`) arrives with the mode of
 * whatever wrote it, often 0644; new files already get 0600 from the process umask (main.ts).
 * When the mode cannot be fixed (the file belongs to another account, typically root after a
 * restore run as root), boot stops: serving would leave every user's data readable to other
 * local accounts. Exported for tests (`chmod` is injectable to simulate a foreign owner).
 */
export function restrictDatabaseFiles(dbFile: string, chmod = chmodSync): void {
  for (const file of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) {
    const stat = statSync(file, { throwIfNoEntry: false });
    if (stat === undefined || (stat.mode & 0o077) === 0) continue;
    try {
      chmod(file, PRIVATE_FILE_MODE);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'unknown error';
      const mode = (stat.mode & 0o777).toString(8).padStart(4, '0');
      throw new Error(
        `${file} is readable by other accounts (mode ${mode}) and cannot be restricted to 0600 ` +
          `(${code}). Make the data directory and its files belong to the user the server runs ` +
          `as (UID 65532 in the Docker image), e.g. chown -R 65532:65532 <data dir>, then start again.`,
      );
    }
  }
}

/**
 * Boot steps 2–5 of docs/spec/08-operations.md §2: ensure the directories, back up an
 * existing database before an update (pending migrations or a different server version than
 * the one that last booted it), migrate, and bootstrap instance settings.
 */
export function prepareDatabase(
  dataDir: string,
  logger: Logger,
  version: string,
  migrationsDir: string = MIGRATIONS_DIR,
): { db: AppDb; instanceId: string } {
  const paths = dataPaths(dataDir);
  for (const dir of [paths.dataDir, paths.backupsDir, paths.attachmentsDir]) {
    mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  }
  const existed = existsSync(paths.dbFile) && statSync(paths.dbFile).size > 0;
  const db = openDb(paths.dbFile);
  try {
    restrictDatabaseFiles(paths.dbFile);
    const migrations = hasPendingMigrations(db, migrationsDir);
    // A missing version on an existing database (booted before this was recorded) counts as
    // changed, so the first boot that records it also takes a backup.
    const from = existed ? readLastBootVersion(db) : undefined;
    if (existed && (migrations || from !== version)) {
      // Keeps the `pre-migrate` prefix: BackupService lists and rotates it as "Before update".
      const backup = join(paths.backupsDir, `pre-migrate-${timestampForFile(new Date())}.db`);
      backupDatabase(db, backup);
      logger.info(
        { backup, from: from ?? null, to: version, migrations },
        'pre-update backup written',
      );
    }
    if (migrations) {
      runMigrations(db, migrationsDir);
      logger.info('database migrations applied');
    }
    const instanceId = ensureInstanceId(db);
    recordBootVersion(db, version);
    return { db, instanceId };
  } catch (err) {
    db.close();
    throw err;
  }
}
