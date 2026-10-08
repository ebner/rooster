import { signInAs, uniqueEmail } from './support/auth';
import { expect, test } from './support/test';
import { markDocument, reloaded, updateChip, updateToast } from './support/update';

/**
 * FR-PWA-6 on phones: `vite` dev runs without a service worker, so a newer server (a mocked
 * SSE `hello`) is the signal. The chip sits in the phone header and a tap reloads.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      sessionStorage.setItem('e2e-init', '1');
      localStorage.setItem('rooster.locale', 'en');
    }
  });
});

test('FR-PWA-6 the phone header shows the "Update" chip; a tap reloads', async ({ page }) => {
  await page.route('**/api/v1/events', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
      body: `event: hello\ndata: ${JSON.stringify({ version: '99.0.0', gitSha: 'e2e', serverTime: 1 })}\n\n`,
    }),
  );
  await signInAs(page, uniqueEmail('phone.update'));
  const header = page.getByTestId('mobile-header');
  await expect(header).toBeVisible();
  await expect(updateToast(page)).toBeVisible({ timeout: 15_000 });
  const chip = header.getByRole('button', { name: 'Update – a new version is available' });
  await expect(chip).toBeVisible();
  // The chip fits the header next to the org switcher and the ⋯ menu.
  const box = await header.boundingBox();
  const chipBox = await chip.boundingBox();
  expect(chipBox && box && chipBox.x + chipBox.width <= box.x + box.width).toBe(true);

  await markDocument(page);
  const load = page.waitForEvent('load');
  await chip.tap();
  await load;
  expect(await reloaded(page)).toBe(true);
  await expect(updateChip(page)).toBeVisible({ timeout: 15_000 });
});
