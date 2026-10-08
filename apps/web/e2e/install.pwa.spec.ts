import { signInAs, uniqueEmail } from './support/auth';
import { controlled, swActive } from './support/pwa';
import { expect, test } from './support/test';

/** Phase 4: installability (AC-4.6) and the update prompt (AC-4.7), against the build. */

test('AC-4.6 the manifest and icons are valid and the service worker controls the app', async ({
  page,
  request,
}) => {
  await page.goto('/login');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBe('/manifest.webmanifest');
  const res = await request.get(href as string);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toMatch(/manifest\+json|json/);
  const manifest = (await res.json()) as {
    name: string;
    short_name: string;
    start_url: string;
    scope: string;
    display: string;
    theme_color: string;
    background_color: string;
    lang: string;
    icons: { src: string; sizes: string; type: string; purpose?: string }[];
  };
  expect(manifest).toMatchObject({
    name: 'rooster',
    short_name: 'rooster',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    theme_color: '#ffffff',
    background_color: '#ffffff',
    lang: 'en',
  });
  const sizes = (purpose: string) =>
    manifest.icons
      .filter((i) => (i.purpose ?? 'any').split(' ').includes(purpose))
      .map((i) => i.sizes);
  expect(sizes('any')).toEqual(expect.arrayContaining(['192x192', '512x512']));
  expect(sizes('maskable')).toContain('512x512');
  for (const icon of manifest.icons) {
    const png = await request.get(icon.src);
    expect(png.status(), icon.src).toBe(200);
    expect(png.headers()['content-type']).toBe('image/png');
    // PNG IHDR width/height must match the declared size.
    const body = await png.body();
    const [w, h] = [body.readUInt32BE(16), body.readUInt32BE(20)];
    expect(`${w}x${h}`).toBe(icon.sizes);
  }
  expect(await page.locator('meta[name="theme-color"]').getAttribute('content')).toBe('#ffffff');

  // The worker installs on the first load and controls the next one.
  await swActive(page);
  await page.reload();
  expect(await controlled(page)).toBe(true);
  const sw = await request.get('/sw.js');
  expect(sw.headers()['cache-control']).toBe('no-cache');

  // Installable per Chromium (the same checks Lighthouse runs): no installability errors.
  const cdp = await page.context().newCDPSession(page);
  const { installabilityErrors } = (await cdp.send('Page.getInstallabilityErrors')) as {
    installabilityErrors: { errorId: string }[];
  };
  expect(installabilityErrors).toEqual([]);
});

test('the service worker never answers the API and serves the shell for app paths', async ({
  page,
}) => {
  await signInAs(page, uniqueEmail('pwa.paths'));
  await swActive(page);
  await page.reload();
  expect(await controlled(page)).toBe(true);
  const fromSw = await page.evaluate(async () => {
    const api = await fetch('/api/v1/me');
    const keys = await caches.keys();
    const cached: string[] = [];
    for (const key of keys) {
      for (const req of await (await caches.open(key)).keys())
        cached.push(new URL(req.url).pathname);
    }
    return { apiStatus: api.status, cached };
  });
  expect(fromSw.apiStatus).toBe(200);
  expect(fromSw.cached.some((p) => p.startsWith('/api/'))).toBe(false);
  expect(fromSw.cached).toContain('/index.html');
  expect(fromSw.cached.some((p) => p.endsWith('.woff2'))).toBe(true);
  expect(fromSw.cached).toContain('/icons/icon-192.png');
});

test('AC-1.0.1 served scripts carry no source map reference', async ({ page, request }) => {
  await page.goto('/login');
  const scripts = await page
    .locator('script[src], link[rel="modulepreload"]')
    .evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute('src') ?? n.getAttribute('href') ?? ''),
    );
  expect(scripts.length).toBeGreaterThan(0);
  for (const src of [...scripts, '/sw.js']) {
    const body = await (await request.get(src)).text();
    expect(body, src).not.toMatch(/sourceMappingURL=/);
  }
});
