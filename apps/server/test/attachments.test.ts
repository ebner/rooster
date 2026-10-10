// Phase 10 (WP 10.2, server side): attachment upload, download, thumbnails, delete, the blob
// GC and the type checks (ADR 0049 §3; AC-10.2; 10 §5 "uploads with a spoofed mime rejected").

import { once } from 'node:events';
import { existsSync, readdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import type {
  Activity,
  ActivityPage,
  Attachment,
  Problem,
  TaskDetail,
} from '@rooster/core/schemas';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanFilename } from '../src/blob/content.ts';
import type { BlobStores } from '../src/blob/store.ts';
import { attachment, blobGc, task } from '../src/db/schema/index.ts';
import type { DomainEvent } from '../src/events/bus.ts';
import { fileForm, png, rotatedJpeg, sendForm } from './blob-helpers.ts';
import { tempDir } from './helpers.ts';
import { type Caller, createTask, listCtx, sharedOrg } from './list-helpers.ts';

const dirs: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of dirs.splice(0)) cleanup();
});

/** Ann owns a shared org with member Bo; Cy is an outsider. Files live in a temp data dir. */
async function team(env: Record<string, string> = {}) {
  const dir = tempDir();
  dirs.push(dir.cleanup);
  const ctx = listCtx({ env: { ROOSTER_DATA_DIR: dir.path, ...env } });
  const a = ctx.user('ann@example.com', 'Ann');
  const b = ctx.user('bo@example.com', 'Bo');
  const c = ctx.user('cy@example.com', 'Cy');
  const org = await sharedOrg(a, [b]);
  const t = await createTask(a, { title: 'Receipts' }, org.id);
  return { ...ctx, dataDir: dir.path, a, b, c, org, taskId: t.id };
}
type Team = Awaited<ReturnType<typeof team>>;

const upload = (ctx: Team, who: Caller, form: FormData, taskId = ctx.taskId) =>
  sendForm(ctx, who, 'POST', `/api/v1/tasks/${taskId}/attachments`, form);

async function uploaded(ctx: Team, who: Caller, form: FormData, taskId = ctx.taskId) {
  const res = await upload(ctx, who, form, taskId);
  const text = await res.text();
  expect(res.status, text).toBe(201);
  return JSON.parse(text) as Attachment;
}

const blobPath = (ctx: Team, key: string) => join(ctx.dataDir, 'attachments', key);
const tmpFiles = (ctx: Team) =>
  existsSync(join(ctx.dataDir, 'tmp')) ? readdirSync(join(ctx.dataDir, 'tmp')) : [];

/**
 * A multipart body of `total` bytes of file content, produced on demand (64 KB per pull), and
 * how much of it the server pulled.
 */
function streamedUpload(total: number) {
  const boundary = `----rooster${Date.now()}`;
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const chunk = new Uint8Array(64 * 1024).fill(0x61);
  const counter = { pulled: 0 };
  let started = false;
  let done = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (!started) {
          started = true;
          controller.enqueue(head);
        } else if (counter.pulled < total) {
          const n = Math.min(chunk.length, total - counter.pulled);
          controller.enqueue(chunk.subarray(0, n));
          counter.pulled += n;
        } else if (!done) {
          done = true;
          controller.enqueue(tail);
          controller.close();
        }
      },
    },
    { highWaterMark: 0 },
  );
  return { body, contentType: `multipart/form-data; boundary=${boundary}`, counter };
}

describe('AC-10.2 attachments', () => {
  it('uploads an image: sniffed type, size, a 320 px WebP thumbnail and attachment_added', async () => {
    const ctx = await team();
    const events: DomainEvent[] = [];
    ctx.app.services.events.on((e) => events.push(e));
    const image = await png(1200, 800);
    const att = await uploaded(ctx, ctx.a, fileForm(image, 'receipt.png', 'image/png'));
    expect(att).toMatchObject({
      taskId: ctx.taskId,
      filename: 'receipt.png',
      mime: 'image/png',
      size: image.length,
      uploaderId: ctx.a.userId,
      image: { width: 1200, height: 800, thumb: true },
    });

    const thumb = await ctx.a.call('GET', `/api/v1/attachments/${att.id}/thumb`);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('content-type')).toBe('image/webp');
    const meta = await sharp(Buffer.from(await thumb.arrayBuffer())).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 320, height: 213 });

    // A fellow member sees it in the task detail, and downloads the original bytes.
    const detail = await ctx.b.ok<TaskDetail>('GET', `/api/v1/tasks/${ctx.taskId}`);
    expect(detail.attachments?.map((x) => x.id)).toEqual([att.id]);
    expect(detail.counts.attachments).toBe(1);
    const res = await ctx.b.call('GET', `/api/v1/attachments/${att.id}`);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(image)).toBe(true);

    const feed = await ctx.a.ok<ActivityPage>('GET', `/api/v1/tasks/${ctx.taskId}/activity`);
    const added = feed.items.find(
      (i) => i.kind === 'activity' && i.activity.type === 'attachment_added',
    ) as { activity: Activity } | undefined;
    expect(added?.activity.data).toEqual({ attachmentId: att.id, filename: 'receipt.png' });

    // The detail, counts and feed of the task are invalidated for every member.
    const update = events.find((e) => e.type === 'task.updated' && e.subjects[0] === ctx.taskId);
    const keys = update?.audiences.flatMap((a) => a.keys.map((k) => k.join('/')));
    expect(keys).toEqual(
      expect.arrayContaining([
        `task/${ctx.taskId}`,
        `activity/${ctx.taskId}`,
        `my-list/${ctx.org.id}`,
        `everyone/${ctx.org.id}`,
      ]),
    );
    expect(tmpFiles(ctx)).toEqual([]);
  });

  it('a non-member gets 404 for the download and the thumbnail; an unknown id too', async () => {
    const ctx = await team();
    const att = await uploaded(ctx, ctx.a, fileForm(await png(40, 40), 'a.png', 'image/png'));
    for (const path of [`/api/v1/attachments/${att.id}`, `/api/v1/attachments/${att.id}/thumb`]) {
      const res = await ctx.c.call('GET', path);
      expect(res.status).toBe(404);
      expect(((await res.json()) as Problem).code).toBe('not_found');
    }
    expect((await upload(ctx, ctx.c, fileForm('x', 'x.txt'))).status).toBe(404);
  });

  it('cuts off 30 MB with a 25 MB limit at 413, without reading or keeping the whole body', async () => {
    const ctx = await team();
    const total = 30 * 1024 * 1024;
    const { body, contentType, counter } = streamedUpload(total);
    const res = await ctx.app.request(`/api/v1/tasks/${ctx.taskId}/attachments`, {
      method: 'POST',
      body,
      duplex: 'half',
      headers: {
        cookie: ctx.a.jar.header(),
        origin: 'http://localhost:3000',
        'content-type': contentType,
      },
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(((await res.json()) as Problem).code).toBe('payload_too_large');
    // Streaming stopped right after the limit: the rest of the body was never pulled in.
    expect(counter.pulled).toBeGreaterThan(25 * 1024 * 1024);
    expect(counter.pulled).toBeLessThan(27 * 1024 * 1024);
    expect(tmpFiles(ctx)).toEqual([]);
    expect(ctx.db.orm.select().from(attachment).all()).toEqual([]);
    expect(existsSync(join(ctx.dataDir, 'attachments', ctx.org.id))).toBe(false);
  });

  it('answers 413 over a real socket while the client is still sending', async () => {
    const ctx = await team({ ROOSTER_UPLOAD_MAX_MB: '2' });
    const server = serve({ fetch: ctx.app.fetch, port: 0, hostname: '127.0.0.1' });
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    try {
      const { body, contentType, counter } = streamedUpload(20 * 1024 * 1024);
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/tasks/${ctx.taskId}/attachments`, {
        method: 'POST',
        body,
        duplex: 'half',
        headers: {
          cookie: ctx.a.jar.header(),
          origin: 'http://localhost:3000',
          'content-type': contentType,
        },
      } as RequestInit);
      expect(res.status).toBe(413);
      expect(((await res.json()) as Problem).code).toBe('payload_too_large');
      expect(counter.pulled).toBeLessThan(20 * 1024 * 1024);
      // The server is fine afterwards.
      const ok = await fetch(`http://127.0.0.1:${port}/api/v1/meta`);
      expect(ok.status).toBe(200);
      expect(tmpFiles(ctx)).toEqual([]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('refuses a declared Content-Length over the limit before reading anything', async () => {
    const ctx = await team({ ROOSTER_UPLOAD_MAX_MB: '1' });
    const { body, contentType, counter } = streamedUpload(3 * 1024 * 1024);
    const res = await ctx.app.request(`/api/v1/tasks/${ctx.taskId}/attachments`, {
      method: 'POST',
      body,
      duplex: 'half',
      headers: {
        cookie: ctx.a.jar.header(),
        origin: 'http://localhost:3000',
        'content-type': contentType,
        'content-length': String(3 * 1024 * 1024 + 200),
      },
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(counter.pulled).toBe(0);
  });

  it('accepts a file of exactly the limit', async () => {
    const ctx = await team({ ROOSTER_UPLOAD_MAX_MB: '1' });
    const bytes = new Uint8Array(1024 * 1024).fill(0x62);
    const att = await uploaded(ctx, ctx.a, fileForm(bytes, 'exact.txt', 'text/plain'));
    expect(att.size).toBe(1024 * 1024);
    const over = await upload(ctx, ctx.a, fileForm(new Uint8Array(1024 * 1024 + 1), 'over.bin'));
    expect(over.status).toBe(413);
  });

  it('rejects a spoofed image with 415 mime_mismatch and stores nothing', async () => {
    const ctx = await team();
    const html = '<html><script>alert(1)</script></html>';
    for (const form of [
      fileForm(html, 'cat.png', 'image/png'),
      fileForm(html, 'cat.txt', 'image/jpeg'),
      fileForm(html, 'cat.JPG', 'application/octet-stream'),
    ]) {
      const res = await upload(ctx, ctx.a, form);
      expect(res.status).toBe(415);
      expect(((await res.json()) as Problem).code).toBe('mime_mismatch');
    }
    expect(ctx.db.orm.select().from(attachment).all()).toEqual([]);
    expect(tmpFiles(ctx)).toEqual([]);
    await ctx.app.services.blobGc.drain();
    expect(existsSync(join(ctx.dataDir, 'attachments', ctx.org.id))).toBe(false);
  });

  it('stores the sniffed type; a PNG claiming to be a JPEG is a mismatch too', async () => {
    const ctx = await team();
    const image = await png(10, 10);
    const renamed = await upload(ctx, ctx.a, fileForm(image, 'photo.jpg', 'image/jpeg'));
    expect(renamed.status).toBe(415);
    expect(((await renamed.json()) as Problem).code).toBe('mime_mismatch');
    // Aliases and an untyped part with the right extension are fine.
    expect((await uploaded(ctx, ctx.a, fileForm(image, 'photo.png', 'image/x-png'))).mime).toBe(
      'image/png',
    );
    expect((await uploaded(ctx, ctx.a, fileForm(image, 'photo.PNG'))).mime).toBe('image/png');
    const text = await uploaded(ctx, ctx.a, fileForm('hej då\n', 'notes', 'application/pdf'));
    expect(text).toMatchObject({ mime: 'text/plain', image: null, filename: 'notes' });
    const bin = await uploaded(ctx, ctx.a, fileForm(new Uint8Array([1, 0, 2, 3]), 'blob.dat'));
    expect(bin.mime).toBe('application/octet-stream');
    const res = await ctx.a.call('GET', `/api/v1/attachments/${text.id}`);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  });

  it('serves downloads with the §3.5 headers; inline only for raster images', async () => {
    const ctx = await team();
    const image = await uploaded(
      ctx,
      ctx.a,
      fileForm(await png(8, 8), 'Kvitto å.png', 'image/png'),
    );
    const res = await ctx.a.call('GET', `/api/v1/attachments/${image.id}`);
    expect(Object.fromEntries(res.headers)).toMatchObject({
      'content-type': 'image/png',
      'content-disposition': `attachment; filename="Kvitto _.png"; filename*=UTF-8''Kvitto%20%C3%A5.png`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, max-age=300',
      'content-length': String(image.size),
    });
    const inline = await ctx.a.call('GET', `/api/v1/attachments/${image.id}?inline=1`);
    expect(inline.headers.get('content-disposition')).toMatch(/^inline; /);

    // SVG is a document that can run script: never an image here, always a download.
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="1" height="1"/></svg>';
    const doc = await uploaded(ctx, ctx.a, fileForm(svg, 'logo.svg', 'image/svg+xml'));
    expect(doc.image).toBeNull();
    expect(doc.mime).not.toMatch(/^image\//);
    const svgRes = await ctx.a.call('GET', `/api/v1/attachments/${doc.id}?inline=1`);
    expect(svgRes.headers.get('content-disposition')).toMatch(/^attachment; /);
    expect(svgRes.headers.get('content-type')).not.toMatch(/svg/);
    expect(svgRes.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect((await ctx.a.call('GET', `/api/v1/attachments/${doc.id}/thumb`)).status).toBe(404);
  });

  it('applies the EXIF orientation to the size and the thumbnail', async () => {
    const ctx = await team();
    const att = await uploaded(ctx, ctx.a, fileForm(await rotatedJpeg(400, 200), 'r.jpg'));
    expect(att.image).toEqual({ width: 200, height: 400, thumb: true });
    const thumb = await ctx.a.call('GET', `/api/v1/attachments/${att.id}/thumb`);
    const meta = await sharp(Buffer.from(await thumb.arrayBuffer())).metadata();
    expect([meta.width, meta.height]).toEqual([160, 320]);
  });

  it('keeps a corrupt image as a plain file without a size or thumbnail', async () => {
    const ctx = await team();
    const broken = Buffer.concat([(await png(50, 50)).subarray(0, 60), Buffer.alloc(40)]);
    const att = await uploaded(ctx, ctx.a, fileForm(broken, 'broken.png', 'image/png'));
    expect(att.mime).toBe('image/png');
    expect(att.image).toBeNull();
  });

  it('cleans file names', () => {
    expect(cleanFilename('C:\\fakepath\\report.pdf', 'pdf')).toBe('report.pdf');
    expect(cleanFilename('../../etc/passwd', null)).toBe('passwd');
    expect(cleanFilename('evil\u202Egnp.exe', 'exe')).toBe('evilgnp.exe');
    expect(cleanFilename('tab\there\u0000.txt', 'txt')).toBe('tabhere.txt');
    expect(cleanFilename('  spaced name.  ', null)).toBe('spaced name');
    expect(cleanFilename('', 'png')).toBe('file.png');
    expect(cleanFilename('..', null)).toBe('file');
    expect(cleanFilename('Cafe\u0301.txt', 'txt')).toBe('Café.txt');
    const long = cleanFilename(`${'a'.repeat(400)}.pdf`, 'pdf');
    expect(Array.from(long)).toHaveLength(255);
    expect(long.endsWith('.pdf')).toBe(true);
    expect(Array.from(cleanFilename('😀'.repeat(300), null))).toHaveLength(255);
  });

  it('answers 422 without a file part, 415 for non-multipart bodies', async () => {
    const ctx = await team();
    const form = new FormData();
    form.append('other', 'value');
    const res = await upload(ctx, ctx.a, form);
    expect(res.status).toBe(422);
    expect(((await res.json()) as Problem).errors?.[0]?.path).toBe('file');
    const json = await ctx.a.call('POST', `/api/v1/tasks/${ctx.taskId}/attachments`, { file: 'x' });
    expect(json.status).toBe(415);
  });

  it('is not idempotent: a key is validated but never stored for an upload', async () => {
    const ctx = await team();
    const send = (key: string) =>
      sendForm(
        ctx,
        ctx.a,
        'POST',
        `/api/v1/tasks/${ctx.taskId}/attachments`,
        fileForm('a', 'a.txt'),
        {
          'idempotency-key': key,
        },
      );
    expect((await send('k1')).status).toBe(201);
    expect((await send('k1')).status).toBe(201);
    expect((await send('not a key!')).status).toBe(422);
  });

  it('refuses uploads to a deleted task (410) and beyond 100 attachments (409)', async () => {
    const ctx = await team();
    const other = await createTask(ctx.a, { title: 'Gone' }, ctx.org.id);
    await ctx.a.ok('DELETE', `/api/v1/tasks/${other.id}`, undefined, 204);
    const gone = await upload(ctx, ctx.a, fileForm('x', 'x.txt'), other.id);
    expect(gone.status).toBe(410);
    const first = await uploaded(ctx, ctx.a, fileForm('x', 'x.txt'));
    const row = ctx.db.orm.select().from(attachment).where(eq(attachment.id, first.id)).get();
    if (row === undefined) throw new Error('row');
    for (let i = 1; i < 100; i++) {
      ctx.db.orm
        .insert(attachment)
        .values({ ...row, id: `${row.id.slice(0, -4)}${String(i).padStart(4, '0')}` })
        .run();
    }
    const full = await upload(ctx, ctx.a, fileForm('x', 'x.txt'));
    expect(full.status).toBe(409);
    expect(((await full.json()) as Problem).code).toBe('too_many_attachments');
  });

  it('needs write access to upload and read access to download (grants)', async () => {
    const ctx = await team();
    const att = await uploaded(ctx, ctx.a, fileForm('x', 'x.txt'));
    const { token } = await ctx.app.services.grants.createToken(ctx.a.actor, {
      name: 'Reader',
      scopes: ['tasks:read'],
      constraints: { orgs: 'all' },
    });
    const bearer = { authorization: `Bearer ${token}` };
    const read = await ctx.app.request(`/api/v1/attachments/${att.id}`, { headers: bearer });
    expect(read.status).toBe(200);
    const write = await ctx.app.request(`/api/v1/tasks/${ctx.taskId}/attachments`, {
      method: 'POST',
      body: fileForm('y', 'y.txt'),
      headers: bearer,
    });
    expect(write.status).toBe(403);
    expect(((await write.json()) as Problem).code).toBe('forbidden_scope');
  });
});

describe('AC-8.4 response validation of the P10 routes', () => {
  it('accepts multipart uploads, binary downloads and avatars without violations', async () => {
    const ctx = await team({ ROOSTER_VALIDATE_RESPONSES: '1' });
    const att = await uploaded(ctx, ctx.a, fileForm(await png(64, 64), 'a.png', 'image/png'));
    const text = await uploaded(ctx, ctx.a, fileForm('hej', 'a.txt', 'text/plain'));
    for (const path of [
      `/api/v1/attachments/${att.id}`,
      `/api/v1/attachments/${att.id}?inline=1`,
      `/api/v1/attachments/${att.id}/thumb`,
      `/api/v1/attachments/${text.id}`,
    ]) {
      const res = await ctx.a.call('GET', path);
      expect(res.status).toBe(200);
      await res.arrayBuffer();
    }
    const avatar = await sendForm(
      ctx,
      ctx.a,
      'PUT',
      '/api/v1/me/avatar',
      fileForm(await png(9, 9), 'me.png'),
    );
    expect(avatar.status).toBe(200);
    expect((await ctx.b.call('GET', `/api/v1/avatars/${ctx.a.userId}`)).status).toBe(200);
    expect((await upload(ctx, ctx.a, fileForm('<p>', 'x.png', 'image/png'))).status).toBe(415);
    await ctx.a.ok('DELETE', `/api/v1/attachments/${att.id}`, undefined, 204);
    await ctx.a.ok('POST', '/api/v1/me/ical-feeds', {}, 201);
    const report = (await (await ctx.app.request('/__test/response-violations')).json()) as {
      checked: number;
      violations: unknown[];
    };
    expect(report.violations).toEqual([]);
    expect(report.checked).toBeGreaterThan(8);
  });
});

describe('deleting attachments and the blob GC', () => {
  it('lets the uploader and the assignee delete; other members get 403, outsiders 404', async () => {
    const ctx = await team();
    const one = await uploaded(ctx, ctx.a, fileForm(await png(20, 20), 'one.png'));
    const two = await uploaded(ctx, ctx.a, fileForm('two', 'two.txt'));
    const forbidden = await ctx.b.call('DELETE', `/api/v1/attachments/${one.id}`);
    expect(forbidden.status).toBe(403);
    expect(((await forbidden.json()) as Problem).code).toBe('forbidden');
    expect((await ctx.c.call('DELETE', `/api/v1/attachments/${one.id}`)).status).toBe(404);

    const row = ctx.db.orm.select().from(attachment).where(eq(attachment.id, one.id)).get();
    expect(existsSync(blobPath(ctx, row?.key ?? ''))).toBe(true);
    expect(existsSync(blobPath(ctx, row?.thumbKey ?? ''))).toBe(true);
    await ctx.a.ok('DELETE', `/api/v1/attachments/${one.id}`, undefined, 204);
    await ctx.app.services.blobGc.drain();
    expect(existsSync(blobPath(ctx, row?.key ?? ''))).toBe(false);
    expect(existsSync(blobPath(ctx, row?.thumbKey ?? ''))).toBe(false);
    expect(ctx.db.orm.select().from(blobGc).all()).toEqual([]);
    expect((await ctx.a.call('GET', `/api/v1/attachments/${one.id}`)).status).toBe(404);

    // Bo becomes the assignee: now he may delete Ann's file.
    await ctx.a.ok('PATCH', `/api/v1/tasks/${ctx.taskId}`, { assigneeId: ctx.b.userId });
    await ctx.b.ok('DELETE', `/api/v1/attachments/${two.id}`, undefined, 204);
  });

  it('frees the blobs of a permanently deleted task and of the trash purge', async () => {
    const ctx = await team();
    const keysOf = (taskId: string) =>
      ctx.db.orm
        .select()
        .from(attachment)
        .where(eq(attachment.taskId, taskId))
        .all()
        .flatMap((r) => [r.key, r.thumbKey].filter((k): k is string => k !== null));

    // Permanent delete from Trash, with an attachment on a subtask too.
    const sub = await createTask(ctx.a, { title: 'Sub', parentId: ctx.taskId }, ctx.org.id);
    await uploaded(ctx, ctx.a, fileForm(await png(30, 30), 'p.png'));
    await uploaded(ctx, ctx.a, fileForm('s', 's.txt'), sub.id);
    const purged = [...keysOf(ctx.taskId), ...keysOf(sub.id)];
    expect(purged).toHaveLength(3);
    await ctx.a.ok('DELETE', `/api/v1/tasks/${ctx.taskId}`, undefined, 204);
    await ctx.a.ok('DELETE', `/api/v1/tasks/${ctx.taskId}/permanent`, undefined, 204);
    await ctx.app.services.blobGc.drain();
    for (const key of purged) expect(existsSync(blobPath(ctx, key))).toBe(false);

    // The retention purge of Trash older than 30 days.
    const old = await createTask(ctx.a, { title: 'Old' }, ctx.org.id);
    await uploaded(ctx, ctx.a, fileForm('o', 'o.txt'), old.id);
    const oldKeys = keysOf(old.id);
    await ctx.a.ok('DELETE', `/api/v1/tasks/${old.id}`, undefined, 204);
    ctx.app.services.retention.purge(Date.now() + 31 * 86_400_000);
    expect(ctx.db.orm.select().from(task).where(eq(task.id, old.id)).get()).toBeUndefined();
    expect(
      ctx.db.orm
        .select()
        .from(blobGc)
        .all()
        .map((r) => r.key),
    ).toEqual(oldKeys);
    await ctx.app.services.blobGc.drain();
    for (const key of oldKeys) expect(existsSync(blobPath(ctx, key))).toBe(false);
  });

  it('keeps failed deletes queued for the next run', async () => {
    const ctx = await team();
    const att = await uploaded(ctx, ctx.a, fileForm('x', 'x.txt'));
    const stores = ctx.app.services.blobs as BlobStores;
    const local = stores.byKind('local');
    if (local === null) throw new Error('local store');
    const original = local.delete.bind(local);
    local.delete = async () => {
      throw new Error('disk on fire');
    };
    await ctx.a.ok('DELETE', `/api/v1/attachments/${att.id}`, undefined, 204);
    const report = await ctx.app.services.blobGc.drain();
    expect(report).toEqual({ deleted: 0, failed: 1 });
    expect(ctx.db.orm.select().from(blobGc).all()).toHaveLength(1);
    local.delete = original;
    expect(await ctx.app.services.blobGc.drain()).toEqual({ deleted: 1, failed: 0 });
    expect(ctx.db.orm.select().from(blobGc).all()).toEqual([]);
  });

  it('refuses deleting from a task in Trash (410)', async () => {
    const ctx = await team();
    const att = await uploaded(ctx, ctx.a, fileForm('x', 'x.txt'));
    await ctx.a.ok('DELETE', `/api/v1/tasks/${ctx.taskId}`, undefined, 204);
    expect((await ctx.a.call('DELETE', `/api/v1/attachments/${att.id}`)).status).toBe(410);
    // Still downloadable while the task is in Trash.
    expect((await ctx.a.call('GET', `/api/v1/attachments/${att.id}`)).status).toBe(200);
  });
});
