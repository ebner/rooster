import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { serve } from '@hono/node-server';
import { createRoute, z } from '@hono/zod-openapi';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/client.ts';
import { bodyLimitFor } from '../src/lib/body-limit.ts';
import type { AppEnv } from '../src/lib/context.ts';
import { AppError } from '../src/lib/errors.ts';
import { BASE_URL, captureLogger, createTestApp, createUserWithSession } from './helpers.ts';

describe('probes', () => {
  it('GET /healthz returns ok', async () => {
    const { app } = createTestApp();
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('GET /readyz returns 200 on a migrated database', async () => {
    const { app } = createTestApp();
    const res = await app.request('/readyz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('GET /readyz returns 503 while migrations are pending', async () => {
    const { app } = createTestApp({ db: openDb(':memory:') });
    const res = await app.request('/readyz');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ reason: 'migrations_pending' });
  });

  it('GET /readyz returns 503 when the database is closed', async () => {
    const { app, db } = createTestApp();
    db.close();
    const res = await app.request('/readyz');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ reason: 'database_error' });
  });
});

describe('GET /api/v1/meta', () => {
  it('reports version, git SHA, providers, features and the server clock', async () => {
    let now = 1_767_225_600_000;
    const { app } = createTestApp({ env: { ROOSTER_GIT_SHA: 'abc1234' }, clock: () => now });
    const res = await app.request('/api/v1/meta');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      version: '0.0.0-test',
      gitSha: 'abc1234',
      providers: [{ id: 'google', name: 'Google' }],
      // Push is always on: VAPID keys are generated when the environment has none (P7).
      features: { email: false, push: true, s3: false },
      // P10: ROOSTER_UPLOAD_MAX_MB (default 25), for a client-side check before uploading.
      uploadMaxBytes: 25 * 1024 * 1024,
      serverTime: 1_767_225_600_000,
    });
    // Read per request, not at boot (P4 clock-skew estimation).
    now += 5_000;
    expect(
      ((await (await app.request('/api/v1/meta')).json()) as { serverTime: number }).serverTime,
    ).toBe(1_767_225_605_000);
  });

  it('derives features from the config', async () => {
    const { app } = createTestApp({
      env: {
        ROOSTER_SMTP_URL: 'smtps://u:p@smtp.example.com:465',
        ROOSTER_MAIL_FROM: 'Rooster <r@example.com>',
        ROOSTER_S3_BUCKET: 'b',
        ROOSTER_S3_ACCESS_KEY_ID: 'k',
        ROOSTER_S3_SECRET_ACCESS_KEY: 's',
      },
    });
    const body = (await (await app.request('/api/v1/meta')).json()) as { features: unknown };
    expect(body.features).toEqual({ email: true, push: true, s3: true });
  });
});

describe('OpenAPI', () => {
  it('serves an OpenAPI 3.1 document that includes /api/v1/meta', async () => {
    const { app } = createTestApp();
    const res = await app.request('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      info: { title: string; version: string };
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info).toMatchObject({ title: 'rooster API', version: '0.0.0-test' });
    expect(doc.paths['/api/v1/meta']).toBeDefined();
    expect(doc.components.schemas.Problem).toBeDefined();
  });

  it('serves the Scalar reference at /api/docs with a nonce-based CSP', async () => {
    const { app } = createTestApp();
    const res = await app.request('/api/docs');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    const csp = res.headers.get('content-security-policy') ?? '';
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeDefined();
    expect(await res.text()).toContain(`nonce="${nonce}"`);
  });
});

describe('errors (problem+json)', () => {
  it('returns a 404 problem for unknown API routes', async () => {
    const { app } = createTestApp();
    const res = await app.request('/api/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'No route for GET /api/nope.',
      code: 'not_found',
    });
  });

  it('answers 401 for any /api/v1 path without a session, so routes are not revealed', async () => {
    const { app } = createTestApp();
    const res = await app.request('/api/v1/nope');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'unauthenticated', status: 401 });
  });

  it('returns 422 validation_failed with field errors from zod-openapi routes', async () => {
    const { app } = createTestApp();
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/_test/echo',
        request: {
          body: {
            content: {
              'application/json': { schema: z.object({ title: z.string().min(1), n: z.number() }) },
            },
          },
        },
        responses: { 200: { description: 'ok' } },
      }),
      (c) => c.json({ ok: true }, 200),
    );
    const res = await app.request('/api/_test/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '', n: 'x' }),
    });
    expect(res.status).toBe(422);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = (await res.json()) as {
      code: string;
      errors: { path: string; message: string }[];
    };
    expect(body.code).toBe('validation_failed');
    expect(body.errors.map((e) => e.path).sort()).toEqual(['n', 'title']);
  });

  it('renders AppError with its code and status', async () => {
    const { app } = createTestApp();
    app.get('/api/_test/conflict', () => {
      throw new AppError('personal_org', 409, 'Personal orgs cannot have members.');
    });
    const res = await app.request('/api/_test/conflict');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      status: 409,
      title: 'Conflict',
      code: 'personal_org',
      detail: 'Personal orgs cannot have members.',
    });
  });

  it('hides internals of unexpected errors and logs them with the request ID', async () => {
    const { logger, lines } = captureLogger();
    const { app } = createTestApp({ logger });
    app.get('/api/_test/boom', () => {
      throw new Error('secret internals');
    });
    const res = await app.request('/api/_test/boom');
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('secret internals');
    expect(JSON.parse(text)).toMatchObject({ code: 'internal_error', status: 500 });
    const reqId = res.headers.get('x-request-id');
    const errorLine = lines.find((l) => l.msg === 'unhandled error');
    expect(errorLine).toMatchObject({ reqId });
  });
});

describe('request IDs and logging', () => {
  it('generates an X-Request-Id', async () => {
    const { app } = createTestApp();
    const res = await app.request('/healthz');
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('honours a sane incoming X-Request-Id and replaces an unsafe one', async () => {
    const { app } = createTestApp();
    const ok = await app.request('/healthz', { headers: { 'X-Request-Id': 'proxy-abc_123=' } });
    expect(ok.headers.get('x-request-id')).toBe('proxy-abc_123=');
    const bad = await app.request('/healthz', { headers: { 'X-Request-Id': 'evil <script>' } });
    expect(bad.headers.get('x-request-id')).not.toContain('<');
    const long = await app.request('/healthz', { headers: { 'X-Request-Id': 'a'.repeat(500) } });
    expect(long.headers.get('x-request-id')).toHaveLength(36);
  });

  it('logs {reqId, method, path, status, ms} per request', async () => {
    const { logger, lines } = captureLogger();
    const { app } = createTestApp({ logger });
    const res = await app.request('/api/v1/meta');
    const line = lines.find((l) => l.msg === 'request');
    expect(line).toMatchObject({
      reqId: res.headers.get('x-request-id'),
      method: 'GET',
      path: '/api/v1/meta',
      status: 200,
    });
    expect(typeof line?.ms).toBe('number');
    expect(line).not.toHaveProperty('userId');
  });

  it('adds the userId of authenticated requests', async () => {
    const { logger, lines } = captureLogger();
    const { app, db } = createTestApp({ logger });
    const { userId, jar } = createUserWithSession(app, db, { email: 'ann@example.com' });
    await app.request('/api/v1/me', { headers: { cookie: jar.header() } });
    expect(lines.find((l) => l.msg === 'request' && l.path === '/api/v1/me')).toMatchObject({
      userId,
      status: 200,
    });
  });
});

describe('security headers', () => {
  it('sets the strict CSP and Referrer-Policy on every response', async () => {
    const { app } = createTestApp();
    const res = await app.request('/api/v1/meta');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("connect-src 'self';");
    expect(csp).toContain("img-src 'self' data: blob: https:");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('also protects problem responses', async () => {
    const { app } = createTestApp();
    const res = await app.request('/api/nope');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
  });
});

describe('request body limits', () => {
  /** A chunked body (no Content-Length) of `total` bytes; `pulled()` counts what was read. */
  function chunked(total: number, chunk = 16 * 1024) {
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= total) {
          controller.close();
          return;
        }
        const size = Math.min(chunk, total - sent);
        sent += size;
        controller.enqueue(new Uint8Array(size).fill(0x20));
      },
    });
    return { stream, pulled: () => sent };
  }

  async function expectTooLarge(res: Response) {
    expect(res.status).toBe(413);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(await res.json()).toMatchObject({ status: 413, code: 'payload_too_large' });
  }

  it('/api/auth/* takes at most 64 KB, before better-auth buffers the body', async () => {
    const { app } = createTestApp();
    const big = JSON.stringify({ provider: 'google', callbackURL: '/', pad: 'x'.repeat(70_000) });
    await expectTooLarge(
      await app.request('/api/auth/sign-in/social', {
        method: 'POST',
        body: big,
        headers: {
          'content-type': 'application/json',
          'content-length': String(big.length),
          origin: BASE_URL,
        },
      }),
    );
    const body = chunked(10 * 1024 * 1024);
    await expectTooLarge(
      await app.request('/api/auth/sign-in/social', {
        method: 'POST',
        body: body.stream,
        headers: { 'content-type': 'application/json', origin: BASE_URL },
        duplex: 'half',
      } as RequestInit),
    );
    // Reading stopped right after the limit.
    expect(body.pulled()).toBeLessThanOrEqual(64 * 1024 + 2 * 16 * 1024);
    const small = await app.request('/api/auth/sign-in/social', {
      method: 'POST',
      body: JSON.stringify({ provider: 'google', callbackURL: '/' }),
      headers: { 'content-type': 'application/json', origin: BASE_URL },
    });
    expect(small.status).toBe(200);
  });

  it('/api/v1/* takes at most 1 MB, declared or chunked; a maximal description fits', async () => {
    const { app, db } = createTestApp({ apiRateLimit: false });
    const { jar } = createUserWithSession(app, db, { email: 'ann@example.com' });
    const headers = {
      cookie: jar.header(),
      origin: BASE_URL,
      'content-type': 'application/json',
    };
    const big = JSON.stringify({ title: 'x', description: 'x'.repeat(1024 * 1024) });
    await expectTooLarge(
      await app.request('/api/v1/orgs/personal/tasks', {
        method: 'POST',
        body: big,
        headers: { ...headers, 'content-length': String(big.length) },
      }),
    );
    const body = chunked(20 * 1024 * 1024, 64 * 1024);
    await expectTooLarge(
      await app.request('/api/v1/orgs/personal/tasks', {
        method: 'POST',
        body: body.stream,
        headers,
        duplex: 'half',
      } as RequestInit),
    );
    expect(body.pulled()).toBeLessThanOrEqual(1024 * 1024 + 2 * 64 * 1024);
    // 100,000 characters of three-byte UTF-8 is still well under the limit.
    const ok = await app.request('/api/v1/orgs/personal/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: 'Long', description: '€'.repeat(100_000) }),
      headers,
    });
    expect(ok.status).toBe(201);
  });
});

describe('request body limits: memory per request', () => {
  /** A body of `count` one-byte chunks, each a view into its own 64 KB buffer (as socket reads are). */
  function dribbled(count: number) {
    let sent = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= count) {
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(new Uint8Array(new ArrayBuffer(64 * 1024), 0, 1).fill(0x20));
      },
    });
  }

  it('coalesces a dribbled body into one bounded buffer instead of holding every chunk', async () => {
    const limit = 16 * 1024;
    const app = new Hono<AppEnv>();
    app.use(bodyLimitFor(limit));
    app.post('/', async (c) => {
      const reader = c.req.raw.body?.getReader();
      let chunks = 0;
      let retained = 0;
      let bytes = 0;
      for (;;) {
        const next = await reader?.read();
        if (next === undefined || next.done) break;
        chunks += 1;
        retained += next.value.buffer.byteLength;
        bytes += next.value.byteLength;
      }
      return c.json({ chunks, retained, bytes });
    });
    const res = await app.request('/', {
      method: 'POST',
      body: dribbled(8 * 1024),
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(200);
    const seen = (await res.json()) as { chunks: number; retained: number; bytes: number };
    expect(seen.bytes).toBe(8 * 1024);
    // Without coalescing: 8,192 chunks pinning 512 MB of backing stores.
    expect(seen.chunks).toBe(1);
    expect(seen.retained).toBeLessThanOrEqual(limit);
  });

  it('over a socket, a dribbled declared body is read and a dribbled chunked one is cut off', async () => {
    const { app } = createTestApp();
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;
    /** Sends the head, then `body` one byte per write with Nagle off; resolves with the status line. */
    const probe = (head: string, body: string[]) =>
      new Promise<string>((resolve, reject) => {
        const socket = connect({ port, host: '127.0.0.1', noDelay: true }, async () => {
          socket.write(head);
          for (const piece of body) {
            if (socket.destroyed) break;
            socket.write(piece);
            await new Promise((r) => setImmediate(r));
          }
        });
        let reply = '';
        socket.on('data', (d: Buffer) => {
          reply += d.toString('latin1');
          if (reply.includes('\r\n')) {
            resolve(reply.slice(0, reply.indexOf('\r\n')));
            socket.destroy();
          }
        });
        socket.on('error', reject);
      });
    try {
      const json = JSON.stringify({ provider: 'google', callbackURL: '/', pad: 'x'.repeat(2_000) });
      const declared = await probe(
        `POST /api/auth/sign-in/social HTTP/1.1\r\nhost: 127.0.0.1\r\norigin: ${BASE_URL}\r\n` +
          `content-type: application/json\r\ncontent-length: ${json.length}\r\n\r\n`,
        [...json],
      );
      expect(declared).toBe('HTTP/1.1 200 OK');
      const oneByteChunk = '1\r\n \r\n';
      const chunked = await probe(
        `POST /api/auth/sign-in/social HTTP/1.1\r\nhost: 127.0.0.1\r\norigin: ${BASE_URL}\r\n` +
          'content-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n',
        Array.from({ length: 64 * 1024 + 16 }, () => oneByteChunk),
      );
      expect(chunked).toBe('HTTP/1.1 413 Payload Too Large');
    } finally {
      server.close();
    }
  }, 30_000);
});
