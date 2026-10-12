import { test as base, expect, type Page } from '@playwright/test';

export { expect };

/** A random private address, so each test's default context is its own client. */
export function randomClientIp(): string {
  const octet = () => Math.floor(Math.random() * 250) + 1;
  return `10.${octet()}.${octet()}.${octet()}`;
}

/**
 * The project's test: the default context gets its own X-Forwarded-For, since the
 * e2e server trusts the proxy header for its per-IP sign-in rate limit.
 */
export const test = base.extend({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads fixture deps from this pattern.
  extraHTTPHeaders: async ({}, use) => {
    await use({ 'X-Forwarded-For': randomClientIp() });
  },
});

/**
 * `page.reload()` for the phone projects: WebKit sometimes fails a reload with "Frame load
 * interrupted" when the dev server reloads the page itself (a module update) at the same time.
 * Then it navigates to the same URL once; any other error still fails.
 */
export async function reload(page: Page): Promise<void> {
  const url = page.url();
  try {
    await page.reload();
  } catch (error) {
    if (!String(error).includes('Frame load interrupted')) throw error;
    await page.goto(url);
  }
}

/**
 * Opens the kitchen sink (`/_dev/ui`, optionally at a section's `#hash`) and waits for its title.
 * It is the heaviest page in the app: a cold load, or any load on a 2-vCPU CI runner, can take
 * well over the default 5 s.
 */
export async function openKitchenSink(page: Page, hash = ''): Promise<void> {
  await page.goto(`/_dev/ui${hash}`);
  // The embedded sign-in screens bring their own h1s, so match the page title by name.
  await expect(page.getByRole('heading', { level: 1, name: 'Kitchen sink' })).toBeVisible({
    timeout: kitchenSinkRender,
  });
}

/** How long the kitchen sink may take to render, after a navigation or a reload. */
export const kitchenSinkRender = 30_000;
