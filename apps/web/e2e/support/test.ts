import { test as base, type Page } from '@playwright/test';

export { expect } from '@playwright/test';

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
