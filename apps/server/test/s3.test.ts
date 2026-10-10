// Phase 10 (04 §4.8, ADR 0049 §3.4–3.5): the S3 blob store, with an injected client whose
// `send` is a fake (presigning is local: no network anywhere).

import { readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type ServerResponse } from 'node:http';
import { type AddressInfo, createServer as createNetServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Attachment, Me } from '@rooster/core/schemas';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { isValidBlobKey } from '../src/blob/keys.ts';
import { S3BlobStore } from '../src/blob/s3-store.ts';
import { LocalBlobStore } from '../src/blob/store.ts';
import { parseConfig } from '../src/config.ts';
import { attachment, blobGc, user } from '../src/db/schema/index.ts';
import { createLogger } from '../src/lib/logger.ts';
import { fileForm, png, sendForm } from './blob-helpers.ts';
import { createTestDb, createUserWithSession, tempDir, testConfig } from './helpers.ts';
import { until } from './sse-client.ts';

const dirs: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of dirs.splice(0)) cleanup();
});

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

/** An S3 client for `https://s3.test` whose commands land in `objects`. */
function fakeS3() {
  const objects = new Map<string, { body: Buffer; type: string | undefined }>();
  const sent: string[] = [];
  const client = new S3Client({
    region: 'eu-north-1',
    endpoint: 'https://s3.test',
    forcePathStyle: true,
    credentials: { accessKeyId: 'AKIDTEST', secretAccessKey: 'secret-test-key' },
  });
  const send = async (command: unknown): Promise<unknown> => {
    if (command instanceof PutObjectCommand) {
      const { Key, Body, ContentType } = command.input;
      sent.push(`put ${Key}`);
      const body = Buffer.isBuffer(Body) ? Body : await readAll(Body as Readable);
      objects.set(String(Key), { body, type: ContentType });
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const object = objects.get(String(command.input.Key));
      if (object === undefined) {
        throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      }
      return { Body: Readable.from([object.body]), ContentLength: object.body.length };
    }
    if (command instanceof DeleteObjectCommand) {
      sent.push(`delete ${command.input.Key}`);
      objects.delete(String(command.input.Key));
      return {};
    }
    throw new Error('unexpected command');
  };
  (client as unknown as { send: typeof send }).send = send;
  return { client, objects, sent };
}

function s3App() {
  const dir = tempDir();
  dirs.push(dir.cleanup);
  const s3 = fakeS3();
  const config = testConfig({
    ROOSTER_DATA_DIR: dir.path,
    ROOSTER_WEB_DIR: '/nonexistent/web',
    ROOSTER_S3_BUCKET: 'rooster-files',
    ROOSTER_S3_ENDPOINT: 'https://s3.test',
    ROOSTER_S3_REGION: 'eu-north-1',
    ROOSTER_S3_ACCESS_KEY_ID: 'AKIDTEST',
    ROOSTER_S3_SECRET_ACCESS_KEY: 'secret-test-key',
    ROOSTER_S3_FORCE_PATH_STYLE: 'true',
  });
  const db = createTestDb();
  const app = createApp({
    config,
    db,
    logger: createLogger('silent'),
    version: '0.0.0-test',
    authRateLimit: false,
    apiRateLimit: false,
    transports: { s3Client: s3.client },
  });
  const owner = createUserWithSession(app, db, { email: 'ann@example.com' });
  const actor = app.services.users.resolveActor(owner.userId, owner.sessionId);
  if (actor === null) throw new Error('actor');
  const t = app.services.tasks.create(actor, 'personal', { title: 'Receipts' });
  return { app, db, s3, owner, actor, taskId: t.id, dataDir: dir.path };
}

describe('S3 blob storage', () => {
  it('stores uploads in the bucket and redirects downloads to a 60 s presigned URL', async () => {
    const ctx = s3App();
    const meta = await (await ctx.app.request('/api/v1/meta')).json();
    expect((meta as { features: { s3: boolean } }).features.s3).toBe(true);

    const res = await sendForm(
      ctx,
      ctx.owner,
      'POST',
      `/api/v1/tasks/${ctx.taskId}/attachments`,
      fileForm(await png(400, 200), 'Kvitto å.png', 'image/png'),
    );
    expect(res.status).toBe(201);
    const att = (await res.json()) as Attachment;
    const row = ctx.db.orm.select().from(attachment).where(eq(attachment.id, att.id)).get();
    expect(row?.storage).toBe('s3');
    expect(ctx.s3.objects.get(row?.key ?? '')?.type).toBe('image/png');
    expect(ctx.s3.objects.get(row?.thumbKey ?? '')?.type).toBe('image/webp');

    const download = await ctx.app.request(`/api/v1/attachments/${att.id}?inline=1`, {
      headers: { cookie: ctx.owner.jar.header() },
    });
    expect(download.status).toBe(302);
    expect(download.headers.get('cache-control')).toBe('no-store');
    const url = new URL(download.headers.get('location') ?? '');
    expect(url.origin).toBe('https://s3.test');
    expect(url.pathname).toBe(`/rooster-files/${row?.key}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('60');
    expect(url.searchParams.get('response-content-type')).toBe('image/png');
    expect(url.searchParams.get('response-content-disposition')).toBe(
      `inline; filename="Kvitto _.png"; filename*=UTF-8''Kvitto%20%C3%A5.png`,
    );
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    // The object response is never reusable from a cache, and neither is the redirect.
    expect(url.searchParams.get('response-cache-control')).toBe('private, no-store');

    const thumb = await ctx.app.request(`/api/v1/attachments/${att.id}/thumb`, {
      headers: { cookie: ctx.owner.jar.header() },
    });
    expect(thumb.status).toBe(302);
    expect(new URL(thumb.headers.get('location') ?? '').pathname).toBe(
      `/rooster-files/${row?.thumbKey}`,
    );

    // Deleting queues both keys; the GC removes them from the bucket.
    const del = await ctx.app.request(`/api/v1/attachments/${att.id}`, {
      method: 'DELETE',
      headers: { cookie: ctx.owner.jar.header(), origin: 'http://localhost:3000' },
    });
    expect(del.status).toBe(204);
    await ctx.app.services.blobGc.drain();
    expect(ctx.s3.objects.size).toBe(0);
    expect(ctx.db.orm.select().from(blobGc).all()).toEqual([]);
  });

  it('reads older local files from local storage after switching to S3', async () => {
    const ctx = s3App();
    const local = new LocalBlobStore(`${ctx.dataDir}/attachments`);
    const res = await sendForm(
      ctx,
      ctx.owner,
      'POST',
      `/api/v1/tasks/${ctx.taskId}/attachments`,
      fileForm('local bytes', 'old.txt'),
    );
    const att = (await res.json()) as Attachment;
    const row = ctx.db.orm.select().from(attachment).where(eq(attachment.id, att.id)).get();
    if (row === undefined) throw new Error('row');
    // Pretend it was uploaded before S3 was configured.
    await local.put(row.key, Buffer.from('local bytes'), 'text/plain');
    ctx.db.orm.update(attachment).set({ storage: 'local' }).where(eq(attachment.id, att.id)).run();
    const download = await ctx.app.request(`/api/v1/attachments/${att.id}`, {
      headers: { cookie: ctx.owner.jar.header() },
    });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe('local bytes');
  });

  it('serves avatars through the server, never as a redirect', async () => {
    const ctx = s3App();
    const put = await sendForm(
      ctx,
      ctx.owner,
      'PUT',
      '/api/v1/me/avatar',
      fileForm(await png(300, 300), 'me.png'),
    );
    expect(put.status).toBe(200);
    const stored = ctx.db.orm.select().from(user).where(eq(user.id, ctx.owner.userId)).get();
    const key = `avatars/${ctx.owner.userId}.${stored?.avatarId}`;
    expect(ctx.s3.objects.has(key)).toBe(true);
    const img = await ctx.app.request(`/api/v1/avatars/${ctx.owner.userId}`, {
      headers: { cookie: ctx.owner.jar.header() },
    });
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/webp');
    const me = (await (
      await ctx.app.request('/api/v1/me/avatar', {
        method: 'DELETE',
        headers: { cookie: ctx.owner.jar.header(), origin: 'http://localhost:3000' },
      })
    ).json()) as Me;
    expect(me.image).toBeNull();
    // Queued for the blob GC, which deletes it from the bucket.
    await ctx.app.services.blobGc.drain();
    expect(ctx.s3.objects.has(key)).toBe(false);
  });
});

describe('blob keys', () => {
  it('accept only the known key schemes', () => {
    const id = '0199c5a2-d7e8-76f9-8a0b-7b8c9d0e1f01';
    expect(isValidBlobKey(`${id}/${id}`)).toBe(true);
    expect(isValidBlobKey(`${id}/${id}.thumb.webp`)).toBe(true);
    expect(isValidBlobKey(`avatars/${id}`)).toBe(true);
    expect(isValidBlobKey(`avatars/${id}.1791628778737`)).toBe(true);
    expect(isValidBlobKey(`avatars/${id}.${id}`)).toBe(true);
    for (const bad of [
      `../${id}`,
      `${id}/../${id}`,
      `${id}/${id}/x`,
      `/${id}/${id}`,
      `avatars/${id}.png`,
      `avatars/${id}.`,
      `avatars/${id}.12345678901234567`,
      `avatars/${id}/1`,
      `${id}/${id}.thumb.png`,
      `${id.toUpperCase()}/${id}`,
      '',
    ]) {
      expect(isValidBlobKey(bad), bad).toBe(false);
    }
  });

  it('are enforced by the local store', async () => {
    const dir = tempDir();
    dirs.push(dir.cleanup);
    const store = new LocalBlobStore(dir.path);
    await expect(store.put('../escape', Buffer.from('x'), 'text/plain')).rejects.toThrow(
      'invalid blob key',
    );
    await expect(store.get('avatars/../../etc/passwd')).rejects.toThrow('invalid blob key');
  });
});

describe('S3 configuration', () => {
  const base = {
    ROOSTER_BASE_URL: 'http://localhost:3000',
    ROOSTER_AUTH_SECRET: 'test-secret-0123456789-abcdefghijklmnop-QRSTUV',
    ROOSTER_ADMIN_EMAILS: 'admin@example.com',
    ROOSTER_GOOGLE_CLIENT_ID: 'id',
    ROOSTER_GOOGLE_CLIENT_SECRET: 'secret',
  };

  it('switches to S3 with a bucket and both keys; the region defaults to us-east-1', () => {
    const result = parseConfig({
      ...base,
      ROOSTER_S3_BUCKET: 'files',
      ROOSTER_S3_ACCESS_KEY_ID: 'id',
      ROOSTER_S3_SECRET_ACCESS_KEY: 'key',
    });
    expect(result.ok && result.config.s3).toEqual({
      bucket: 'files',
      endpoint: null,
      region: 'us-east-1',
      accessKeyId: 'id',
      secretAccessKey: 'key',
      forcePathStyle: false,
    });
    const local = parseConfig(base);
    expect(local.ok && local.config.s3).toBeNull();
    expect(local.ok && local.config.uploadMaxMb).toBe(25);
  });

  it('refuses a bucket without keys and a non-http endpoint', () => {
    const missing = parseConfig({ ...base, ROOSTER_S3_BUCKET: 'files' });
    expect(missing.ok).toBe(false);
    const ftp = parseConfig({ ...base, ROOSTER_S3_ENDPOINT: 'ftp://s3.example.com' });
    expect(!ftp.ok && ftp.errors.join()).toMatch(/ROOSTER_S3_ENDPOINT/);
  });
});

describe('S3 request deadlines', () => {
  it('a backend that never answers fails put, get and delete instead of hanging', async () => {
    // Accepts connections and reads requests, but never answers.
    const sockets = new Set<Socket>();
    const server = createNetServer((socket) => {
      sockets.add(socket);
      socket.on('data', () => {});
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    const store = new S3BlobStore({
      bucket: 'rooster-files',
      endpoint: `http://127.0.0.1:${port}`,
      region: 'eu-north-1',
      accessKeyId: 'AKIDTEST',
      secretAccessKey: 'secret-test-key',
      forcePathStyle: true,
      timeoutMs: 300,
    });
    const key = 'avatars/0199c5a2-d7e8-76f9-8a0b-7b8c9d0e1f01';
    try {
      for (const op of [
        () => store.put(key, Buffer.from('x'), 'image/webp'),
        () => store.get(key),
        () => store.delete(key),
      ]) {
        const start = Date.now();
        await expect(op()).rejects.toThrow();
        expect(Date.now() - start).toBeLessThan(3_000);
      }
      // The aborted requests' connections are closed, not left open.
      await until(() => sockets.size === 0, 2_000, 'connections closed');
    } finally {
      server.close();
    }
  }, 15_000);
});

/**
 * A loopback S3 (path style, bucket `rooster-files`) whose answers a test chooses: objects are
 * kept in memory; `put` and `get` can misbehave as real backends do.
 */
async function loopbackS3() {
  const objects = new Map<string, Buffer>();
  const behaviour: {
    put: 'ok' | 'forbid' | 'store-then-hang';
    get: 'ok' | 'stall-body';
  } = { put: 'ok', get: 'ok' };
  const sockets = new Set<Socket>();
  const stored = { count: 0 };
  const keyOf = (url: string | undefined) =>
    decodeURIComponent((url ?? '').split('?')[0]?.replace(/^\/rooster-files\//, '') ?? '');
  const forbid = (res: ServerResponse) => {
    res.writeHead(403, { 'content-type': 'application/xml' });
    res.end('<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>');
  };
  const server = createHttpServer((req, res) => {
    const key = keyOf(req.url);
    if (req.method === 'PUT') {
      if (behaviour.put === 'forbid') return forbid(res);
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        objects.set(key, Buffer.concat(chunks));
        stored.count += 1;
        // Stored, but the answer never comes (lost on the way, a stalled proxy).
        if (behaviour.put === 'store-then-hang') return;
        res.writeHead(200, { etag: '"x"' });
        res.end();
      });
      return;
    }
    if (req.method === 'GET') {
      const object = objects.get(key);
      if (object === undefined) {
        res.writeHead(404, { 'content-type': 'application/xml' });
        res.end('<Error><Code>NoSuchKey</Code><Message>none</Message></Error>');
        return;
      }
      res.writeHead(200, { 'content-length': String(object.length) });
      if (behaviour.get === 'stall-body') res.write(object.subarray(0, 4));
      else res.end(object);
      return;
    }
    if (req.method === 'DELETE') {
      objects.delete(key);
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(400);
    res.end();
  });
  // Expect: 100-continue: refuse before the body is sent, as S3 does.
  server.on('checkContinue', (req, res) => {
    if (behaviour.put === 'forbid') return forbid(res);
    res.writeContinue();
    server.emit('request', req, res);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const store = new S3BlobStore({
    bucket: 'rooster-files',
    endpoint: `http://127.0.0.1:${port}`,
    region: 'eu-north-1',
    accessKeyId: 'AKIDTEST',
    secretAccessKey: 'secret-test-key',
    forcePathStyle: true,
    timeoutMs: 300,
  });
  return {
    store,
    objects,
    stored,
    behaviour,
    sockets,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** Descriptors of this process open on `path` (Linux). */
function openDescriptors(path: string): number {
  return readdirSync('/proc/self/fd').filter((fd) => {
    try {
      return readlinkSync(`/proc/self/fd/${fd}`) === path;
    } catch {
      return false;
    }
  }).length;
}

describe('S3 lifecycle (loopback)', () => {
  const key = 'avatars/0199c5a2-d7e8-76f9-8a0b-7b8c9d0e1f01';

  it.skipIf(process.platform !== 'linux')(
    'a refused PUT closes its source file',
    async () => {
      const s3 = await loopbackS3();
      const dir = tempDir();
      dirs.push(dir.cleanup);
      const file = join(dir.path, 'upload.bin');
      writeFileSync(file, Buffer.alloc(3 * 1024 * 1024, 1));
      s3.behaviour.put = 'forbid';
      try {
        for (let i = 0; i < 3; i++) {
          await expect(
            s3.store.put(key, { file, size: 3 * 1024 * 1024 }, 'application/octet-stream'),
          ).rejects.toThrow();
        }
        await until(() => openDescriptors(file) === 0, 2_000, 'descriptors closed');
      } finally {
        s3.close();
      }
    },
    15_000,
  );
});
