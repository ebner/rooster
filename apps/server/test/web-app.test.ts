import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app.ts';
import { captureLogger, createTestApp, tempDir } from './helpers.ts';

let web: ReturnType<typeof tempDir>;
let app: App;

beforeAll(() => {
  web = tempDir('rooster-web-');
  mkdirSync(join(web.path, 'assets'));
  writeFileSync(join(web.path, 'index.html'), '<!doctype html><title>rooster</title>');
  writeFileSync(join(web.path, 'sw.js'), 'self.addEventListener("fetch", () => {});');
  writeFileSync(join(web.path, 'assets', 'app-abc123.js'), 'console.log(1);');
  ({ app } = createTestApp({ env: { ROOSTER_WEB_DIR: web.path } }));
});
afterAll(() => web.cleanup());

describe('web app serving', () => {
  it('serves index.html at / without caching', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toContain('<title>rooster</title>');
  });

  it('serves hashed assets with an immutable cache', async () => {
    const res = await app.request('/assets/app-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await res.text()).toBe('console.log(1);');
  });

  it('serves sw.js without caching', async () => {
    const res = await app.request('/sw.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it('falls back to index.html for client-side routes', async () => {
    const res = await app.request('/o/personal/my-tasks?view=list');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toContain('<title>rooster</title>');
  });

  it('does not fall back for a missing hashed asset', async () => {
    const res = await app.request('/assets/missing-000.js');
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBeNull();
  });

  it.each(['/api/nope', '/api', '/ical/feed.ics'])('does not fall back for %s', async (path) => {
    const res = await app.request(path);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
  });

  it('does not fall back for non-GET requests', async () => {
    const res = await app.request('/some/page', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('rejects path traversal', async () => {
    const res = await app.request('/assets/../../etc/passwd');
    expect(await res.text()).not.toContain('root:');
  });
});

describe('without a web build', () => {
  it('warns once and returns 404 for SPA paths', async () => {
    const { logger, lines } = captureLogger();
    const { app: apiOnly } = createTestApp({
      logger,
      env: { ROOSTER_WEB_DIR: '/nonexistent/web' },
    });
    const res = await apiOnly.request('/o/personal/my-tasks');
    await apiOnly.request('/');
    expect(res.status).toBe(404);
    const warnings = lines.filter((l) => String(l.msg).startsWith('web build not found'));
    expect(warnings).toHaveLength(1);
  });
});
