import { signInAs, uniqueEmail } from './support/auth';
import { controlled, waitForPending } from './support/pwa';
import { expect, test } from './support/test';
import {
  addUnsavedTask,
  deferredChip,
  markDocument,
  reloaded,
  startEditing,
  stopEditing,
  updateChip,
  updateToast,
} from './support/update';

/**
 * FR-PWA-6 without a service worker (unsupported, blocked or failed to register): the SSE
 * `hello` of a newer server is the only signal, and Reload is a plain page reload, still held
 * back by the update gate.
 */
test.use({ serviceWorkers: 'block' });

const newerHello = `event: hello\ndata: ${JSON.stringify({ version: '99.0.0', gitSha: 'e2e', serverTime: 1 })}\n\n`;

test('FR-PWA-6 a newer server without a service worker: toast, chip, gated reload', async ({
  page,
}) => {
  await page.route('**/api/v1/events', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
      body: newerHello,
    }),
  );
  await signInAs(page, uniqueEmail('pwa.nosw'));
  await expect(page.getByRole('treegrid')).toBeVisible();
  expect(await controlled(page)).toBe(false);

  await expect(updateToast(page)).toBeVisible({ timeout: 15_000 });
  await expect(updateChip(page)).toBeVisible();
  await updateToast(page).getByRole('button', { name: 'Dismiss' }).click();
  await expect(updateToast(page)).toHaveCount(0);
  // The stream reconnects (and says hello) every few seconds: the toast does not come back.
  await page.waitForTimeout(4_000);
  await expect(updateToast(page)).toHaveCount(0);
  await expect(updateChip(page)).toBeVisible();

  const unsaved = await addUnsavedTask(page, 'Saved before the reload');
  await markDocument(page);
  await updateChip(page).click();
  await expect(deferredChip(page)).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: 'Reloading as soon as your changes are saved' }),
  ).toBeVisible();

  // Saved, but a text editor has focus: still no reload.
  await startEditing(page);
  await unsaved.release();
  await waitForPending(page, 0);
  await page.waitForTimeout(1_500);
  expect(await reloaded(page)).toBe(false);

  const load = page.waitForEvent('load');
  await stopEditing(page);
  await load;
  expect(await reloaded(page)).toBe(true);
  await expect(page.getByRole('treegrid')).toBeVisible();
  await expect(page.getByText('Saved before the reload')).toBeVisible();
  // This bundle is still older than the (mocked) server, so the chip is back.
  await expect(updateChip(page)).toBeVisible({ timeout: 15_000 });
});
