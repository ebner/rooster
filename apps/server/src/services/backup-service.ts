import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BACKUP_NAME_REGEX, type Backup, type BackupKind } from '@rooster/core/schemas';
import { dataPaths, PRIVATE_DIR_MODE } from '../db/boot.ts';
import { backupDatabase } from '../db/migrate.ts';
import { AppError } from '../lib/errors.ts';
import type { Actor, ServiceDeps } from './context.ts';
import { requireBrowserSession } from './grant-access.ts';

/** Manual and pre-migration snapshots are never rotated away below this count each. */
export const KEEP_MANUAL = 10;

/** `2026-10-05T03:00:00.000Z` → `2026-10-05T03-00-00-000Z`, as in boot.ts. */
export function backupTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[:.]/g, '-');
}

interface ParsedName {
  prefix: 'rooster' | 'manual' | 'pre-migrate';
  date: string;
  createdAt: number;
}

function parseName(name: string): ParsedName | null {
  const m = BACKUP_NAME_REGEX.exec(name);
  if (m === null) return null;
  const [, prefix, date, hh, mm, ss, ms] = m as unknown as [
    string,
    ParsedName['prefix'],
    string,
    string,
    string,
    string,
    string,
  ];
  const createdAt = Date.parse(`${date}T${hh}:${mm}:${ss}.${ms}Z`);
  if (Number.isNaN(createdAt)) return null;
  return { prefix, date, createdAt };
}

/** A scheduled snapshot taken on a Sunday (UTC) is a weekly one. */
function kindOf(parsed: ParsedName): BackupKind {
  if (parsed.prefix === 'manual') return 'manual';
  if (parsed.prefix === 'pre-migrate') return 'pre-migrate';
  return new Date(parsed.createdAt).getUTCDay() === 0 ? 'weekly' : 'daily';
}

function requireAdmin(actor: Actor): void {
  if (!actor.isAdmin) throw new AppError('forbidden', 403, 'Only instance admins can do that.');
}

const backupNotFound = () => new AppError('not_found', 404, 'Backup not found.');

/**
 * `VACUUM INTO` snapshots in `<dataDir>/backups` (WP 2.9, 08 §7): the nightly job with
 * rotation, and the admin list, "back up now" and download.
 */
export class BackupService {
  constructor(private readonly deps: ServiceDeps) {}

  get dir(): string {
    return dataPaths(this.deps.config.dataDir).backupsDir;
  }

  private entries(): (Backup & ParsedName)[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .flatMap((name) => {
        const parsed = parseName(name);
        if (parsed === null) return [];
        const stat = statSync(join(this.dir, name), { throwIfNoEntry: false });
        if (stat === undefined || !stat.isFile()) return [];
        return [{ ...parsed, name, size: stat.size, kind: kindOf(parsed) }];
      })
      .sort((a, b) => b.createdAt - a.createdAt || (a.name < b.name ? 1 : -1));
  }

  /** Newest first. */
  list(actor: Actor): Backup[] {
    requireBrowserSession(actor);
    requireAdmin(actor);
    return this.entries().map(({ name, size, createdAt, kind }) => ({
      name,
      size,
      createdAt,
      kind,
    }));
  }

  /** "Back up now" (manual kind). */
  createManual(actor: Actor): Backup {
    requireBrowserSession(actor);
    requireAdmin(actor);
    const backup = this.snapshot('manual', this.deps.clock());
    this.rotate();
    return backup;
  }

  /**
   * The file behind a download. Only names produced by this service are accepted, so a
   * path such as `../rooster.db` can never resolve outside the backups folder.
   */
  file(actor: Actor, name: string): { path: string; size: number; name: string } {
    requireBrowserSession(actor);
    requireAdmin(actor);
    if (parseName(name) === null) throw backupNotFound();
    const path = join(this.dir, name);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isFile()) throw backupNotFound();
    return { path, size: stat.size, name };
  }

  /**
   * The scheduled job: one snapshot per UTC day, even across restarts (an existing
   * scheduled snapshot of today means there is nothing to do), then rotation.
   */
  runScheduled(now: number = this.deps.clock()): Backup | null {
    const today = backupTimestamp(now).slice(0, 10);
    const done = this.entries().some((e) => e.prefix === 'rooster' && e.date === today);
    const backup = done ? null : this.snapshot('rooster', now);
    this.rotate();
    return backup;
  }

  private snapshot(prefix: 'rooster' | 'manual', now: number): Backup {
    mkdirSync(this.dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    let at = now;
    let name = `${prefix}-${backupTimestamp(at)}.db`;
    while (existsSync(join(this.dir, name))) {
      at += 1;
      name = `${prefix}-${backupTimestamp(at)}.db`;
    }
    // Written under a name the listing ignores, then renamed, so a half-written file is
    // never offered for download or counted by the rotation.
    const partial = join(this.dir, `${name}.partial`);
    rmSync(partial, { force: true });
    backupDatabase(this.deps.db, partial);
    renameSync(partial, join(this.dir, name));
    const parsed = parseName(name) as ParsedName;
    const size = statSync(join(this.dir, name)).size;
    this.deps.logger.info({ backup: name, size }, 'backup written');
    return { name, size, createdAt: parsed.createdAt, kind: kindOf(parsed) };
  }

  /**
   * Keeps the newest `keepDaily` scheduled snapshots, plus the newest `keepWeekly` Sunday
   * ones (a snapshot in both sets counts once), plus the newest 10 manual and 10
   * pre-migration snapshots. Everything else in the folder that matches the naming scheme is
   * deleted; unknown files are left alone.
   */
  rotate(): string[] {
    const { keepDaily, keepWeekly } = this.deps.config.backup;
    const all = this.entries();
    const keep = new Set<string>();
    const scheduled = all.filter((e) => e.prefix === 'rooster');
    for (const e of scheduled.slice(0, keepDaily)) keep.add(e.name);
    for (const e of scheduled.filter((s) => s.kind === 'weekly').slice(0, keepWeekly)) {
      keep.add(e.name);
    }
    for (const prefix of ['manual', 'pre-migrate'] as const) {
      for (const e of all.filter((x) => x.prefix === prefix).slice(0, KEEP_MANUAL)) {
        keep.add(e.name);
      }
    }
    const removed = all.filter((e) => !keep.has(e.name)).map((e) => e.name);
    for (const name of removed) rmSync(join(this.dir, name), { force: true });
    if (removed.length > 0) this.deps.logger.info({ removed }, 'old backups rotated');
    return removed;
  }
}
