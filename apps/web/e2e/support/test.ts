import { test as base } from '@playwright/test';

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
