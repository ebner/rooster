import { createRoute, z } from '@hono/zod-openapi';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/client.ts';
import { AppError } from '../src/lib/errors.ts';
import { captureLogger, createTestApp } from './helpers.ts';

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
  it('reports version, git SHA, providers and features', async () => {
    const { app } = createTestApp({ env: { ROOSTER_GIT_SHA: 'abc1234' } });
    const res = await app.request('/api/v1/meta');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      version: '0.0.0-test',
      gitSha: 'abc1234',
      providers: [],
      features: { email: false, push: false, s3: false },
    });
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
    expect(body.features).toEqual({ email: true, push: false, s3: true });
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
    expect(doc.info).toEqual({ title: 'rooster API', version: '0.0.0-test' });
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
    const res = await app.request('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'No route for GET /api/v1/nope.',
      code: 'not_found',
    });
  });

  it('returns 422 validation_failed with field errors from zod-openapi routes', async () => {
    const { app } = createTestApp();
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/_test/echo',
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
    const res = await app.request('/api/v1/_test/echo', {
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
    app.get('/api/v1/_test/conflict', () => {
      throw new AppError('personal_org', 409, 'Personal orgs cannot have members.');
    });
    const res = await app.request('/api/v1/_test/conflict');
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
    app.get('/api/v1/_test/boom', () => {
      throw new Error('secret internals');
    });
    const res = await app.request('/api/v1/_test/boom');
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
    const res = await app.request('/api/v1/nope');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
  });
});
