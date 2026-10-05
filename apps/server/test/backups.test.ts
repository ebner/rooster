import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Backup } from '@rooster/core/schemas';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupTimestamp } from '../src/services/backup-service.ts';
import { tempDir } from './helpers.ts';
import { createTask, listCtx } from './list-helpers.ts';

const DAY = 86_400_000;

let dir: ReturnType<typeof tempDir>;
beforeEach(() => {
  dir = tempDir();
});
afterEach(() => {
  dir.cleanup();
});

function setup(options: { now?: () => number; keepDaily?: number; keepWeekly?: number } = {}) {
  const ctx = listCtx({
    ...(options.now === undefined ? {} : { clock: options.now }),
    env: {
      ROOSTER_DATA_DIR: dir.path,
      ...(options.keepDaily === undefined
        ? {}
        : { ROOSTER_BACKUP_KEEP_DAILY: String(options.keepDaily) }),
      ...(options.keepWeekly === undefined
        ? {}
        : { ROOSTER_BACKUP_KEEP_WEEKLY: String(options.keepWeekly) }),
    },
  });
  const admin = ctx.user('admin@example.com');
  const user = ctx.user('user@example.com');
  const backups = join(dir.path, 'backups');
  mkdirSync(backups, { recursive: true });
  return { ctx, admin, user, backups };
}

describe('WP 2.9 backups', () => {
  it('an admin takes, lists and downloads a consistent snapshot', async () => {
    const { admin, backups } = setup();
    await createTask(admin, { title: 'precious' });
    const created = await admin.ok<Backup>('POST', '/api/v1/admin/backups', undefined, 201);
    expect(created).toMatchObject({ kind: 'manual', size: expect.any(Number) });
    expect(created.name).toMatch(/^manual-\d{4}-\d{2}-\d{2}T[\d-]+Z\.db$/);
    expect(await admin.ok<Backup[]>('GET', '/api/v1/admin/backups')).toEqual([created]);

    const res = await admin.call('GET', `/api/v1/admin/backups/${created.name}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${created.name}"`);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.length).toBe(created.size);
    const copy = join(dir.path, 'download.db');
    writeFileSync(copy, bytes);
    const db = new Database(copy, { readonly: true });
    try {
      expect(db.prepare('SELECT title FROM task').all()).toEqual([{ title: 'precious' }]);
    } finally {
      db.close();
    }
    expect(readdirSync(backups)).toEqual([created.name]);
  });

  it('rejects path traversal and unknown names with 404; non-admins get 403', async () => {
    const { admin, user, backups } = setup();
    writeFileSync(join(backups, '..', 'secret.db'), 'nope');
    for (const name of [
      '..%2Fsecret.db',
      '..%2F..%2Frooster.db',
      'secret.db',
      'rooster-2026-10-05T03-00-00-000Z.db',
      'rooster-2026-10-05T03-00-00-000Z.db%00.txt',
    ]) {
      const res = await admin.call('GET', `/api/v1/admin/backups/${name}`);
      expect(res.status, name).toBe(404);
    }
    expect((await user.call('GET', '/api/v1/admin/backups')).status).toBe(403);
    expect((await user.call('POST', '/api/v1/admin/backups')).status).toBe(403);
  });

  it('takes one scheduled snapshot per day, even after a restart', async () => {
    let now = Date.UTC(2026, 9, 5, 3); // a Monday
    const { ctx } = setup({ now: () => now });
    const first = ctx.app.services.backups.runScheduled();
    expect(first?.kind).toBe('daily');
    now += 60_000;
    expect(ctx.app.services.backups.runScheduled()).toBeNull();
    // A fresh process (new services) sees the file on disk.
    const again = setup({ now: () => now });
    expect(again.ctx.app.services.backups.runScheduled()).toBeNull();
    now += DAY;
    expect(again.ctx.app.services.backups.runScheduled()?.name).toBe(
      `rooster-${backupTimestamp(now)}.db`,
    );
  });

  it('rotates to 7 daily + 4 weekly and keeps the last 10 manual and pre-migrate', async () => {
    const { ctx, admin, backups } = setup({ keepDaily: 7, keepWeekly: 4 });
    const start = Date.UTC(2026, 6, 1, 3); // Wed 1 Jul 2026
    const names: string[] = [];
    for (let d = 0; d < 60; d++) {
      const name = `rooster-${backupTimestamp(start + d * DAY)}.db`;
      writeFileSync(join(backups, name), 'x');
      names.push(name);
    }
    for (let i = 0; i < 12; i++) {
      writeFileSync(join(backups, `manual-${backupTimestamp(start + i * 1000)}.db`), 'x');
      writeFileSync(join(backups, `pre-migrate-${backupTimestamp(start + i * 1000)}.db`), 'x');
    }
    writeFileSync(join(backups, 'notes.txt'), 'operator file');
    ctx.app.services.backups.rotate();

    const left = readdirSync(backups);
    const daily = left.filter((n) => n.startsWith('rooster-')).sort();
    const sundays = names.filter((n) => new Date(n.slice(8, 18)).getUTCDay() === 0);
    const expected = [...new Set([...names.slice(-7), ...sundays.slice(-4)])].sort();
    expect(daily).toEqual(expected);
    expect(daily.length).toBeGreaterThanOrEqual(7);
    expect(left.filter((n) => n.startsWith('manual-'))).toHaveLength(10);
    expect(left.filter((n) => n.startsWith('pre-migrate-'))).toHaveLength(10);
    expect(left).toContain('notes.txt');

    const listed = ctx.app.services.backups.list(admin.actor);
    expect(listed.filter((b) => b.kind === 'weekly').length).toBeGreaterThanOrEqual(4);
    expect(listed[0]?.createdAt).toBeGreaterThanOrEqual(listed[1]?.createdAt ?? 0);
  });
});
