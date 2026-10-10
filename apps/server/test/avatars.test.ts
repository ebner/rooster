// Phase 10 (FR-SET-1, ADR 0049 §3.7): uploaded avatars.

import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Me, Problem } from '@rooster/core/schemas';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import type { BlobStore } from '../src/blob/store.ts';
import type { UploadSlots } from '../src/blob/upload-slots.ts';
import { user } from '../src/db/schema/index.ts';
import { fileForm, png, sendForm } from './blob-helpers.ts';
import { tempDir } from './helpers.ts';
import { type Caller, listCtx, sharedOrg } from './list-helpers.ts';
import { until } from './sse-client.ts';

const dirs: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of dirs.splice(0)) cleanup();
});

const PROVIDER_PICTURE = 'https://idp.example.com/ann.png';

async function team(clock?: () => number) {
  const dir = tempDir();
  dirs.push(dir.cleanup);
  const ctx = listCtx({ env: { ROOSTER_DATA_DIR: dir.path }, ...(clock ? { clock } : {}) });
  const a = ctx.user('ann@example.com', 'Ann');
  const b = ctx.user('bo@example.com', 'Bo');
  const c = ctx.user('cy@example.com', 'Cy');
  await sharedOrg(a, [b]);
  ctx.db.orm.update(user).set({ image: PROVIDER_PICTURE }).where(eq(user.id, a.userId)).run();
  return { ...ctx, dataDir: dir.path, a, b, c };
}
type Team = Awaited<ReturnType<typeof team>>;

const put = (ctx: Team, who: Caller, form: FormData) =>
  sendForm(ctx, who, 'PUT', '/api/v1/me/avatar', form);

/** The avatar blobs on disk (file names under `attachments/avatars`). */
const avatarFiles = (ctx: Team) => {
  const dir = join(ctx.dataDir, 'attachments', 'avatars');
  return existsSync(dir) ? readdirSync(dir).sort() : [];
};

const row = (ctx: Team, id: string) => ctx.db.orm.select().from(user).where(eq(user.id, id)).get();

describe('avatars (FR-SET-1)', () => {
  it('stores a 256 px WebP cover crop, points image at it and serves it to co-members', async () => {
    const ctx = await team();
    const res = await put(ctx, ctx.a, fileForm(await png(600, 300), 'me.png', 'image/png'));
    expect(res.status).toBe(200);
    const me = (await res.json()) as Me;
    const stored = row(ctx, ctx.a.userId);
    expect(me.image).toBe(`/api/v1/avatars/${ctx.a.userId}?v=${stored?.avatarAt}`);
    expect(stored?.oidcImage).toBe(PROVIDER_PICTURE);

    for (const who of [ctx.a, ctx.b]) {
      const img = await who.call('GET', `/api/v1/avatars/${ctx.a.userId}`);
      expect(img.status).toBe(200);
      expect(img.headers.get('content-type')).toBe('image/webp');
      expect(img.headers.get('cache-control')).toBe('private, no-cache');
      expect(img.headers.get('etag')).toBe(`"avatar-${stored?.avatarAt}-${stored?.avatarId}"`);
      const meta = await sharp(Buffer.from(await img.arrayBuffer())).metadata();
      expect(meta).toMatchObject({ format: 'webp', width: 256, height: 256 });
    }
    // Cy shares no org with Ann.
    expect((await ctx.c.call('GET', `/api/v1/avatars/${ctx.a.userId}`)).status).toBe(404);
    // Bo has no uploaded avatar.
    expect((await ctx.a.call('GET', `/api/v1/avatars/${ctx.b.userId}`)).status).toBe(404);
  });

  it('revalidates cached avatars: 304 for co-members, never after sign-out or removal', async () => {
    const ctx = await team();
    await put(ctx, ctx.a, fileForm(await png(40, 40), 'me.png'));
    const path = `/api/v1/avatars/${ctx.a.userId}`;
    const etag = (await ctx.b.call('GET', path)).headers.get('etag') ?? '';
    const again = await ctx.b.call('GET', path, undefined, { 'if-none-match': etag });
    expect(again.status).toBe(304);
    expect(again.headers.get('cache-control')).toBe('private, no-cache');
    expect((await ctx.app.request(path, { headers: { 'if-none-match': etag } })).status).toBe(401);
    expect((await ctx.c.call('GET', path, undefined, { 'if-none-match': etag })).status).toBe(404);
    // A new upload changes the validator.
    await put(ctx, ctx.a, fileForm(await png(50, 50), 'me.png'));
    expect((await ctx.b.call('GET', path, undefined, { 'if-none-match': etag })).status).toBe(200);
    await ctx.a.ok('DELETE', '/api/v1/me/avatar');
    expect((await ctx.b.call('GET', path, undefined, { 'if-none-match': etag })).status).toBe(404);
  });

  it('a second upload keeps the provider picture; DELETE restores it and removes the blob', async () => {
    const ctx = await team();
    await put(ctx, ctx.a, fileForm(await png(64, 64), 'one.png'));
    const first = row(ctx, ctx.a.userId)?.image;
    await put(ctx, ctx.a, fileForm(await png(80, 80), 'two.png'));
    const second = row(ctx, ctx.a.userId);
    expect(second?.image).not.toBe(first);
    expect(second?.oidcImage).toBe(PROVIDER_PICTURE);

    const me = await ctx.a.ok<Me>('DELETE', '/api/v1/me/avatar');
    expect(me.image).toBe(PROVIDER_PICTURE);
    expect(row(ctx, ctx.a.userId)).toMatchObject({ avatarAt: null, oidcImage: null });
    // Both uploads' blobs were queued for the GC, which deletes them.
    await ctx.app.services.blobGc.drain();
    expect(avatarFiles(ctx)).toEqual([]);
    expect((await ctx.b.call('GET', `/api/v1/avatars/${ctx.a.userId}`)).status).toBe(404);
    // Without an upload DELETE changes nothing.
    expect((await ctx.a.ok<Me>('DELETE', '/api/v1/me/avatar')).image).toBe(PROVIDER_PICTURE);
  });

  it('a clock that repeats after a removal never gives the new avatar the removed one’s key', async () => {
    // Every upload, removal and GC run sees the same instant (a clock set back, say).
    const ctx = await team(() => 1_791_600_000_000);
    const path = `/api/v1/avatars/${ctx.a.userId}`;
    const solid = (g: number) =>
      sharp({ create: { width: 60, height: 60, channels: 3, background: { r: 0, g, b: 0 } } })
        .png()
        .toBuffer();
    expect((await put(ctx, ctx.a, fileForm(await solid(20), 'a.png'))).status).toBe(200);
    const first = await ctx.b.call('GET', path);
    const removedEtag = first.headers.get('etag') ?? '';
    await ctx.a.ok('DELETE', '/api/v1/me/avatar');
    expect((await put(ctx, ctx.a, fileForm(await solid(220), 'b.png'))).status).toBe(200);
    // The GC deletes A's blob, not B's.
    await ctx.app.services.blobGc.drain();
    const stored = row(ctx, ctx.a.userId);
    expect(avatarFiles(ctx)).toEqual([`${ctx.a.userId}.${stored?.avatarId}`]);
    const served = await ctx.b.call('GET', path);
    expect(served.status).toBe(200);
    // A copy of A cached under its ETag is not revalidated as B.
    expect(served.headers.get('etag')).not.toBe(removedEtag);
    const cached = await ctx.b.call('GET', path, undefined, { 'if-none-match': removedEtag });
    expect(cached.status).toBe(200);
  });

  it('an upload keeps its slot while storage stalls: a fourth is 429', async () => {
    const ctx = await team();
    const slots = (ctx.app.services.avatars as unknown as { uploads: UploadSlots }).uploads;
    const store = ctx.app.services.blobs.current;
    const realPut = store.put.bind(store);
    let open = () => {};
    const stalled = new Promise<void>((resolve) => {
      open = resolve;
    });
    let storing = 0;
    store.put = async (...args: Parameters<typeof realPut>) => {
      storing += 1;
      await stalled;
      return realPut(...args);
    };
    const image = await png(64, 64);
    const held = [1, 2, 3].map(() => put(ctx, ctx.a, fileForm(image, 'me.png')));
    // One is storing, two wait for the per-user lock: all three still hold their slot.
    await until(() => storing === 1, 2_000, 'storage reached');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(slots.inFlight(ctx.a.userId).uploads).toBe(3);
    const fourth = await put(ctx, ctx.a, fileForm(image, 'me.png'));
    expect(fourth.status).toBe(429);
    open();
    expect((await Promise.all(held)).map((r) => r.status)).toEqual([200, 200, 200]);
    expect(slots.inFlight(ctx.a.userId)).toEqual({ uploads: 0, bytes: 0 });
    store.put = realPut;
  });

  it('removals waiting behind a stalled upload are bounded too (429 with Retry-After)', async () => {
    const ctx = await team();
    const slots = (ctx.app.services.avatars as unknown as { uploads: UploadSlots }).uploads;
    const store = ctx.app.services.blobs.current;
    const realPut = store.put.bind(store);
    let open = () => {};
    const stalled = new Promise<void>((resolve) => {
      open = resolve;
    });
    let storing = 0;
    store.put = async (...args: Parameters<typeof realPut>) => {
      storing += 1;
      await stalled;
      return realPut(...args);
    };
    const upload = put(ctx, ctx.a, fileForm(await png(64, 64), 'me.png'));
    await until(() => storing === 1, 2_000, 'storage reached');
    // Two removals wait for the per-user lock; a third has no slot left.
    const waiting = [1, 2].map(() => ctx.a.call('DELETE', '/api/v1/me/avatar'));
    await until(() => slots.inFlight(ctx.a.userId).uploads === 3, 2_000, 'removals queued');
    const refused = await ctx.a.call('DELETE', '/api/v1/me/avatar');
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('5');
    expect(((await refused.json()) as Problem).code).toBe('rate_limited');
    open();
    expect((await upload).status).toBe(200);
    expect((await Promise.all(waiting)).map((r) => r.status)).toEqual([200, 200]);
    expect(slots.inFlight(ctx.a.userId)).toEqual({ uploads: 0, bytes: 0 });
    store.put = realPut;
  });

  it('serialises an upload and a removal: the blob always matches the row', async () => {
    const ctx = await team();
    await put(ctx, ctx.a, fileForm(await png(64, 64), 'one.png'));
    const image = await png(70, 70);
    await Promise.all([
      put(ctx, ctx.a, fileForm(image, 'two.png')),
      ctx.a.call('DELETE', '/api/v1/me/avatar'),
    ]);
    await ctx.app.services.blobGc.drain();
    const stored = row(ctx, ctx.a.userId)?.avatarId ?? null;
    expect(avatarFiles(ctx)).toEqual(stored === null ? [] : [`${ctx.a.userId}.${stored}`]);
  });

  it('a later profile update from sign-in never replaces the uploaded avatar', async () => {
    const ctx = await team();
    await put(ctx, ctx.a, fileForm(await png(64, 64), 'one.png'));
    const avatar = row(ctx, ctx.a.userId)?.image;
    const auth = await ctx.app.auth.$context;
    await auth.internalAdapter.updateUser(ctx.a.userId, {
      image: 'https://idp.example.com/new.png',
    });
    expect(row(ctx, ctx.a.userId)).toMatchObject({
      image: avatar,
      oidcImage: 'https://idp.example.com/new.png',
    });
    expect((await ctx.a.ok<Me>('DELETE', '/api/v1/me/avatar')).image).toBe(
      'https://idp.example.com/new.png',
    );
  });

  it('refuses non-images (415), spoofed images (415 mime_mismatch) and files over 2 MB (413)', async () => {
    const ctx = await team();
    const text = await put(ctx, ctx.a, fileForm('hello', 'notes.txt', 'text/plain'));
    expect(text.status).toBe(415);
    expect(((await text.json()) as Problem).code).toBe('unsupported_media_type');
    const spoof = await put(ctx, ctx.a, fileForm('hello', 'me.png', 'image/png'));
    expect(spoof.status).toBe(415);
    expect(((await spoof.json()) as Problem).code).toBe('mime_mismatch');
    const big = await put(ctx, ctx.a, fileForm(new Uint8Array(2 * 1024 * 1024 + 1), 'big.png'));
    expect(big.status).toBe(413);
    expect(row(ctx, ctx.a.userId)?.avatarAt).toBeNull();
  });

  it('is a browser-session setting: tokens get 403', async () => {
    const ctx = await team();
    const { token } = await ctx.app.services.grants.createToken(ctx.a.actor, {
      name: 'Script',
      scopes: ['tasks:read', 'tasks:write'],
      constraints: { orgs: 'all' },
    });
    const res = await ctx.app.request('/api/v1/me/avatar', {
      method: 'PUT',
      body: fileForm(await png(10, 10), 'me.png'),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });
});

describe('avatars across a storage switch', () => {
  /** An in-memory stand-in for the S3 backend. */
  function memoryS3(): BlobStore & { objects: Map<string, Buffer> } {
    const objects = new Map<string, Buffer>();
    return {
      kind: 's3',
      objects,
      async put(key, body) {
        objects.set(key, Buffer.isBuffer(body) ? body : await readFile(body.file));
      },
      async get(key) {
        const bytes = objects.get(key);
        return bytes === undefined ? null : { stream: Readable.from([bytes]), size: bytes.length };
      },
      async delete(key) {
        objects.delete(key);
      },
    };
  }

  it('an avatar stored before generation keys is still served, and goes when replaced', async () => {
    const ctx = await team();
    const local = ctx.app.services.blobs.byKind('local');
    if (local === null) throw new Error('no local store');
    // As 1.4 left it: the shared key, no recorded backend.
    const legacy = await sharp(await png(256, 256))
      .webp()
      .toBuffer();
    await local.put(`avatars/${ctx.a.userId}`, legacy, 'image/webp');
    ctx.db.orm
      .update(user)
      .set({ avatarAt: 1_000, image: `/api/v1/avatars/${ctx.a.userId}?v=1000` })
      .where(eq(user.id, ctx.a.userId))
      .run();
    const path = `/api/v1/avatars/${ctx.a.userId}`;
    const old = await ctx.b.call('GET', path);
    expect(old.status).toBe(200);
    expect(Buffer.from(await old.arrayBuffer()).equals(legacy)).toBe(true);
    expect((await put(ctx, ctx.a, fileForm(await png(40, 40), 'new.png'))).status).toBe(200);
    const stored = row(ctx, ctx.a.userId);
    expect(stored?.avatarStorage).toBe('local');
    expect(avatarFiles(ctx)).toEqual([`${ctx.a.userId}.${stored?.avatarId}`]);
    expect((await ctx.b.call('GET', path)).status).toBe(200);
  });

  it('a removed avatar left in another bucket never comes back, not even with its key', async () => {
    const ctx = await team();
    const stores = ctx.app.services.blobs;
    const local = stores.byKind('local');
    if (local === null) throw new Error('no local store');
    const bucket1 = memoryS3();
    const bucket2 = memoryS3();
    const configure = (bucket: BlobStore) => {
      stores.current = bucket;
      stores.byKind = (kind) => (kind === 'local' ? local : bucket);
    };
    const path = `/api/v1/avatars/${ctx.a.userId}`;
    const solid = (g: number) =>
      sharp({ create: { width: 60, height: 60, channels: 3, background: { r: 0, g, b: 0 } } })
        .png()
        .toBuffer();

    configure(bucket1);
    expect((await put(ctx, ctx.a, fileForm(await solid(20), 'a.png'))).status).toBe(200);
    // The operator moves to another bucket; the removal cannot reach the first one.
    configure(bucket2);
    await ctx.a.ok('DELETE', '/api/v1/me/avatar');
    await ctx.app.services.blobGc.drain();
    expect(bucket1.objects.size).toBe(1);
    expect((await put(ctx, ctx.a, fileForm(await solid(220), 'b.png'))).status).toBe(200);
    const served = Buffer.from(await (await ctx.b.call('GET', path)).arrayBuffer());
    expect(served.equals(bucket2.objects.values().next().value as Buffer)).toBe(true);

    // The first bucket comes back: B is not there, and A is never served for it.
    configure(bucket1);
    expect((await ctx.b.call('GET', path)).status).toBe(404);
  });

  it('a removed avatar left in an unconfigured backend never comes back', async () => {
    const ctx = await team();
    const stores = ctx.app.services.blobs;
    const local = stores.byKind('local');
    if (local === null) throw new Error('no local store');
    const s3 = memoryS3();
    const configure = (on: boolean) => {
      stores.current = on ? s3 : local;
      stores.byKind = (kind) => (kind === 'local' ? local : on ? s3 : null);
    };
    const path = `/api/v1/avatars/${ctx.a.userId}`;
    const bytesOf = async (res: Response) => Buffer.from(await res.arrayBuffer());
    const solid = (g: number) =>
      sharp({ create: { width: 60, height: 60, channels: 3, background: { r: 0, g, b: 0 } } })
        .png()
        .toBuffer();

    configure(true);
    expect((await put(ctx, ctx.a, fileForm(await solid(20), 'a.png'))).status).toBe(200);
    const first = await bytesOf(await ctx.b.call('GET', path));
    expect(s3.objects.size).toBe(1);

    // S3 is switched off: the removal cannot reach the old picture there.
    configure(false);
    await ctx.a.ok('DELETE', '/api/v1/me/avatar');
    expect(s3.objects.size).toBe(1);
    const res = await put(ctx, ctx.a, fileForm(await solid(220), 'b.png'));
    expect(res.status).toBe(200);
    const second = await bytesOf(await ctx.b.call('GET', path));
    expect(second.equals(first)).toBe(false);

    // S3 comes back: the replacement is still the picture, not the removed one.
    configure(true);
    const served = await ctx.b.call('GET', path);
    expect(served.status).toBe(200);
    expect((await bytesOf(served)).equals(second)).toBe(true);
    expect(row(ctx, ctx.a.userId)?.avatarStorage).toBe('local');
  });
});
