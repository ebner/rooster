// WP 11.1 (ADR 0052 §6, AC-11.2): the per-user attachment storage quota. An upload that would
// take the uploader past ROOSTER_USER_STORAGE_MB is `413 storage_quota_exceeded` and nothing
// is stored; GET /me reports the usage.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Attachment, Me, Problem } from '@rooster/core/schemas';
import { afterEach, describe, expect, it } from 'vitest';
import { attachment, blobGc } from '../src/db/schema/index.ts';
import { fileForm, sendForm } from './blob-helpers.ts';
import { tempDir } from './helpers.ts';
import { type Caller, createTask, listCtx, sharedOrg } from './list-helpers.ts';

const MB = 1024 * 1024;
const dirs: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of dirs.splice(0)) cleanup();
});

/** Ann and Bo share an org; the quota is `quotaMb` (1 MB unless given). */
async function team(quotaMb = '1') {
  const dir = tempDir();
  dirs.push(dir.cleanup);
  const ctx = listCtx({
    env: { ROOSTER_DATA_DIR: dir.path, ROOSTER_USER_STORAGE_MB: quotaMb },
  });
  const a = ctx.user('ann@example.com', 'Ann');
  const b = ctx.user('bo@example.com', 'Bo');
  const org = await sharedOrg(a, [b]);
  const t = await createTask(a, { title: 'Receipts' }, org.id);
  return { ...ctx, dataDir: dir.path, a, b, org, taskId: t.id };
}
type Team = Awaited<ReturnType<typeof team>>;

const bytes = (n: number) => new Uint8Array(n).fill(0x61);
const upload = (ctx: Team, who: Caller, size: number, taskId = ctx.taskId) =>
  sendForm(ctx, who, 'POST', `/api/v1/tasks/${taskId}/attachments`, fileForm(bytes(size), 'f.txt'));

async function uploaded(ctx: Team, who: Caller, size: number, taskId = ctx.taskId) {
  const res = await upload(ctx, who, size, taskId);
  const text = await res.text();
  expect(res.status, text).toBe(201);
  return JSON.parse(text) as Attachment;
}

const storageOf = async (who: Caller) => (await who.ok<Me>('GET', '/api/v1/me')).storage;

/** Every blob under `<dataDir>/attachments`. */
function blobFiles(ctx: Team): string[] {
  const root = join(ctx.dataDir, 'attachments');
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);
}
const tmpFiles = (ctx: Team) =>
  existsSync(join(ctx.dataDir, 'tmp')) ? readdirSync(join(ctx.dataDir, 'tmp')) : [];

describe('WP 11.1 per-user attachment storage quota (ADR 0052 §6)', () => {
  it('GET /me reports the bytes my uploads take and the quota', async () => {
    const ctx = await team('2');
    expect(await storageOf(ctx.a)).toEqual({ usedBytes: 0, quotaBytes: 2 * MB });
    await uploaded(ctx, ctx.a, 1000);
    await uploaded(ctx, ctx.a, 2000);
    await uploaded(ctx, ctx.b, 500);
    expect(await storageOf(ctx.a)).toEqual({ usedBytes: 3000, quotaBytes: 2 * MB });
    // Bo's upload counts for Bo, not for the task's owner.
    expect((await storageOf(ctx.b))?.usedBytes).toBe(500);
    // PATCH /me answers the same DTO.
    const patched = await ctx.a.ok<Me>('PATCH', '/api/v1/me', { name: 'Ann L' });
    expect(patched.storage).toEqual({ usedBytes: 3000, quotaBytes: 2 * MB });
  });

  it('AC-11.2 an upload past the quota is 413 storage_quota_exceeded and nothing is stored', async () => {
    const ctx = await team('1');
    await uploaded(ctx, ctx.a, 700 * 1024);
    const before = blobFiles(ctx);
    const res = await upload(ctx, ctx.a, 400 * 1024);
    expect(res.status).toBe(413);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const problem = (await res.json()) as Problem & { usedBytes?: number };
    expect(problem.code).toBe('storage_quota_exceeded');
    expect(problem.limitBytes).toBe(MB);
    expect(problem.usedBytes).toBe(700 * 1024);
    expect(problem.detail).toContain('1 MB');
    // No row, no blob, no temp file.
    expect(ctx.db.orm.select().from(attachment).all()).toHaveLength(1);
    expect(blobFiles(ctx)).toEqual(before);
    expect(tmpFiles(ctx)).toEqual([]);
    // Exactly up to the quota is fine; one byte more is not.
    await uploaded(ctx, ctx.a, MB - 700 * 1024);
    expect((await upload(ctx, ctx.a, 1)).status).toBe(413);
    // The quota is per uploader: Bo still has room on the same task.
    await uploaded(ctx, ctx.b, 1000);
  });

  it('deleting an attachment frees its bytes', async () => {
    const ctx = await team('1');
    const first = await uploaded(ctx, ctx.a, 900 * 1024);
    expect((await upload(ctx, ctx.a, 200 * 1024)).status).toBe(413);
    await ctx.a.ok('DELETE', `/api/v1/attachments/${first.id}`, undefined, 204);
    expect((await storageOf(ctx.a))?.usedBytes).toBe(0);
    await uploaded(ctx, ctx.a, 200 * 1024);
  });

  it('attachments on tasks in Trash count until the task is purged', async () => {
    const ctx = await team('1');
    const other = await createTask(ctx.a, { title: 'Old' }, ctx.org.id);
    await uploaded(ctx, ctx.a, 900 * 1024, other.id);
    await ctx.a.ok('DELETE', `/api/v1/tasks/${other.id}`, undefined, 204);
    expect((await storageOf(ctx.a))?.usedBytes).toBe(900 * 1024);
    expect((await upload(ctx, ctx.a, 200 * 1024)).status).toBe(413);
    await ctx.a.ok('DELETE', `/api/v1/tasks/${other.id}/permanent`, undefined, 204);
    expect((await storageOf(ctx.a))?.usedBytes).toBe(0);
    await uploaded(ctx, ctx.a, 200 * 1024);
  });

  it('two concurrent uploads that each fit cannot both pass; the loser stores nothing', async () => {
    const ctx = await team('1');
    // Both uploads are held at the blob store until each has passed the early check, so the
    // check inside the recording transaction is the one that decides.
    const store = ctx.app.services.blobs.current;
    const put = store.put.bind(store);
    let arrived = 0;
    let release!: () => void;
    const bothThere = new Promise<void>((resolve) => {
      release = resolve;
    });
    store.put = async (...args: Parameters<typeof put>) => {
      arrived += 1;
      if (arrived === 2) release();
      await bothThere;
      return put(...args);
    };
    const results = await Promise.all([
      upload(ctx, ctx.a, 600 * 1024),
      upload(ctx, ctx.a, 600 * 1024),
    ]);
    store.put = put;
    expect(arrived).toBe(2);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 413]);
    const loser = results.find((r) => r.status === 413) as Response;
    expect(((await loser.json()) as Problem).code).toBe('storage_quota_exceeded');
    expect(ctx.db.orm.select().from(attachment).all()).toHaveLength(1);
    expect((await storageOf(ctx.a))?.usedBytes).toBe(600 * 1024);
    // The loser's blob was queued for the GC; once it ran, only the winner's blob is left.
    await ctx.app.services.blobGc.drain();
    expect(ctx.db.orm.select().from(blobGc).all()).toEqual([]);
    expect(blobFiles(ctx)).toHaveLength(1);
    expect(tmpFiles(ctx)).toEqual([]);
  });

  it('ROOSTER_USER_STORAGE_MB=0 means no quota', async () => {
    const ctx = await team('0');
    expect(await storageOf(ctx.a)).toEqual({ usedBytes: 0, quotaBytes: null });
    await uploaded(ctx, ctx.a, 2 * MB);
    expect(await storageOf(ctx.a)).toEqual({ usedBytes: 2 * MB, quotaBytes: null });
  });

  it('the default quota is 1024 MB', async () => {
    const dir = tempDir();
    dirs.push(dir.cleanup);
    const ctx = listCtx({ env: { ROOSTER_DATA_DIR: dir.path } });
    const a = ctx.user('ann@example.com');
    expect(await storageOf(a)).toEqual({ usedBytes: 0, quotaBytes: 1024 * MB });
  });
});
