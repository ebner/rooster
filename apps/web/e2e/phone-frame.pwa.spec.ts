import { devices } from '@playwright/test';
import { newClient } from './support/auth';
import { expectChromeInPlace, pullDown, seedLongList, touchDrag } from './support/phone-frame';
import { expect, test } from './support/test';

/**
 * 02 §13.1 in the production build on a Pixel 8: the bottom nav and
 * the header never move, whatever the list or a pull to refresh does, and the document cannot
 * be scrolled. (Chromium cannot emulate display-mode standalone; the frame does not depend on
 * it, and a standalone window has no browser toolbar to change the viewport.)
 */

test('the production build on a phone keeps its bottom nav and header fixed', async ({
  browser,
  baseURL,
}) => {
  const context = await newClient(browser, {
    ...devices['Pixel 8'],
    ...(baseURL ? { baseURL } : {}),
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await page.addInitScript(() => localStorage.setItem('rooster.locale', 'en'));
  await seedLongList(page, 'frame.build');

  const before = await expectChromeInPlace(page, 'initial');
  expect(before.docScrollHeight).toBeLessThanOrEqual(before.innerHeight);
  const mid = Math.round(before.innerHeight / 2);
  for (let i = 0; i < 6; i++) await touchDrag(cdp, 200, mid + 200, mid - 250);
  await page.waitForTimeout(400);
  expect((await expectChromeInPlace(page, 'scrolled past the end')).listScrollTop).toBeGreaterThan(
    0,
  );
  for (let i = 0; i < 6; i++) await touchDrag(cdp, 200, mid - 250, mid + 200);
  await page.waitForTimeout(400);
  await expectChromeInPlace(page, 'scrolled past the top');

  const row = await page.getByText('Task 1', { exact: true }).boundingBox();
  const y = Math.round((row?.y ?? 200) + 10);
  await pullDown(page, 300, y, 220);
  await expect(page.getByTestId('pull-to-refresh')).toHaveAttribute('data-state', 'idle');
  await touchDrag(cdp, 300, y, y + 300);
  await page.waitForTimeout(600);
  const after = await expectChromeInPlace(page, 'after pulls to refresh');
  expect(after.nav).toEqual(before.nav);
  expect(after.docScrollHeight).toBe(before.docScrollHeight);
  await context.close();
});
