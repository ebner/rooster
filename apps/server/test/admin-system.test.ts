// WP 11.5 (ADR 0052 §7, 08 §9, AC-11.5): GET /admin/system, the data behind Admin → System.

import { join } from 'node:path';
import { type AdminSystem, adminSystemSchema } from '@rooster/core/schemas';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { JobBoard } from '../src/jobs/job-board.ts';
import { createScheduler } from '../src/jobs/scheduler.ts';
import { VERSION } from '../src/version.ts';
import { subscriptionBody } from './delivery-fakes.ts';
import { asJar, captureLogger, tempDir } from './helpers.ts';
import { createTask, listCtx } from './list-helpers.ts';
import { SseClient, until } from './sse-client.ts';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fileCtx(env: Record<string, string> = {}) {
  const dir = tempDir();
  const db = openDb(join(dir.path, 'rooster.db'));
  runMigrations(db);
  cleanups.push(dir.cleanup, () => db.close());
  const ctx = listCtx({ db, env: { ROOSTER_DATA_DIR: dir.path, ...env } });
  return { ...ctx, dataDir: dir.path };
}

const system = async (who: { ok: <T>(m: string, p: string) => Promise<T> }) => {
  const body = await who.ok<AdminSystem>('GET', '/api/v1/admin/system');
  // The DTO is exactly the shared schema.
  expect(adminSystemSchema.parse(body)).toEqual(body);
  return body;
};

describe('WP 11.5 GET /admin/system', () => {
  it('reports version, database, backups, storage, push, SSE and counts', async () => {
    const ctx = fileCtx({ ROOSTER_GIT_SHA: 'abc1234', ROOSTER_USER_STORAGE_MB: '50' });
    const admin = ctx.user('admin@example.com', 'Admin');
    const ann = ctx.user('ann@example.com', 'Ann');
    const t1 = await createTask(ann, { title: 'One' });
    await createTask(ann, { title: 'Two' });
    const gone = await createTask(ann, { title: 'Gone' });
    await ann.ok('DELETE', `/api/v1/tasks/${gone.id}`, undefined, 204);
    const form = new FormData();
    form.append('file', new File([new Uint8Array(1234)], 'a.bin'));
    const up = await ctx.app.request(
      `/api/v1/tasks/${t1.id}/attachments`,
      asJar(ann.jar, { method: 'POST', body: form }),
    );
    expect(up.status).toBe(201);

    let s = await system(admin);
    expect(s.version).toBe(VERSION);
    expect(s.gitSha).toBe('abc1234');
    expect(s.startedAt).toBeLessThanOrEqual(Date.now());
    expect(s.database.sizeBytes).toBeGreaterThan(0);
    expect(s.database.walSizeBytes).toBeGreaterThan(0);
    expect(s.lastBackup).toBeNull();
    expect(s.smtp).toEqual({ configured: false });
    expect(s.push).toEqual({ keySource: 'none', subscriptions: 0 });
    expect(s.sse).toEqual({ connections: 0 });
    expect(s.storage).toEqual({
      backend: 'local',
      attachmentBytes: 1234,
      attachmentCount: 1,
      userQuotaBytes: 50 * 1024 * 1024,
    });
    // Personal orgs count; the task in Trash does not.
    expect(s.counts).toEqual({ users: 2, orgs: 2, tasks: 2 });
    expect(s.jobs).toEqual([]);

    // A backup, generated push keys with a subscription, and an open event stream.
    const backup = await admin.ok<{ name: string; size: number; createdAt: number }>(
      'POST',
      '/api/v1/admin/backups',
      undefined,
      201,
    );
    ctx.app.services.push.ensureKeys();
    await ann.ok('POST', '/api/v1/me/push-subscriptions', subscriptionBody('dev1'), 201);
    const res = await ann.call('GET', '/api/v1/events');
    const stream = new SseClient(res);
    cleanups.push(() => stream.close());
    await until(() => stream.hello !== undefined, 1_000, 'hello');

    s = await system(admin);
    expect(s.lastBackup).toEqual({
      name: backup.name,
      createdAt: backup.createdAt,
      sizeBytes: backup.size,
    });
    expect(s.push).toEqual({ keySource: 'generated', subscriptions: 1 });
    expect(s.sse).toEqual({ connections: 1 });
  });

  it('SMTP, env push keys and no quota', async () => {
    const ctx = fileCtx({
      ROOSTER_SMTP_URL: 'smtp://mail.example.com:25',
      ROOSTER_MAIL_FROM: 'rooster@example.com',
      ROOSTER_VAPID_PUBLIC: `B${'A'.repeat(86)}`,
      ROOSTER_VAPID_PRIVATE: 'A'.repeat(43),
      ROOSTER_USER_STORAGE_MB: '0',
    });
    const admin = ctx.user('admin@example.com');
    const s = await system(admin);
    expect(s.smtp.configured).toBe(true);
    expect(s.push.keySource).toBe('env');
    expect(s.storage.userQuotaBytes).toBeNull();
    expect(s.gitSha).toBeNull();
  });

  it('lists each scheduled job with its last run and a failure without user content', async () => {
    const ctx = fileCtx();
    const admin = ctx.user('admin@example.com');
    const board = ctx.app.services.jobBoard;
    const scheduler = createScheduler(captureLogger().logger, { board, clock: () => 1_000 });
    cleanups.push(() => scheduler.stop());
    scheduler.register('fine', '0 0 1 1 *', () => {});
    scheduler.register('broken', '0 0 1 1 *', () => {
      throw new Error('Failed query: insert into task values (?)\nparams: Secret title');
    });
    scheduler.register('idle', '0 0 1 1 *', () => {});
    await scheduler.run('fine');
    await scheduler.run('broken');
    const s = await system(admin);
    expect(s.jobs).toEqual([
      { job: 'fine', lastRunAt: 1_000, lastStatus: 'ok', lastError: null },
      {
        job: 'broken',
        lastRunAt: 1_000,
        lastStatus: 'failed',
        lastError: 'Failed query: insert into task values (?)',
      },
      { job: 'idle', lastRunAt: null, lastStatus: null, lastError: null },
    ]);
    expect(JSON.stringify(s)).not.toContain('Secret title');
  });

  it('a JobBoard truncates long errors', () => {
    const board = new JobBoard();
    board.finished('x', 5, new Error('e'.repeat(1000)));
    expect(board.list()[0]?.lastError).toHaveLength(300);
  });

  it('members and non-admins get 403 forbidden', async () => {
    const ctx = fileCtx();
    const ann = ctx.user('ann@example.com');
    const res = await ann.call('GET', '/api/v1/admin/system');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('forbidden');
  });
});
