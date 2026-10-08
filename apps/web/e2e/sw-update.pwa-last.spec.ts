import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page, Route } from '@playwright/test';
import { signInAs, uniqueEmail } from './support/auth';
import { myList, personalOrg } from './support/p3';
import { controlled, swActive, waitForPending } from './support/pwa';
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

/** The served build (playwright.config.ts `ROOSTER_WEB_DIR`). */
const swPath = resolve(import.meta.dirname, '../dist/sw.js');

test('AC-4.7 a deploy shows "New version available"; Reload waits for the outbox', async ({
  page,
}) => {
  await signInAs(page, uniqueEmail('pwa.update'));
  const orgId = await personalOrg(page);
  await swActive(page);
  await page.reload();
  expect(await controlled(page)).toBe(true);
  await expect(page.getByRole('treegrid')).toBeVisible();

  // An op that cannot finish yet: the server does not answer creates for now.
  const held: Route[] = [];
  await page.route('**/api/v1/orgs/*/tasks', (route) => {
    if (route.request().method() === 'POST') held.push(route);
    else void route.continue();
  });
  await page.getByRole('button', { name: 'Add task' }).first().click();
  await page.keyboard.type('Unsaved work');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect.poll(() => held.length).toBe(1);
  await waitForPending(page, 1);

  const original = readFileSync(swPath, 'utf8');
  try {
    // "Deploy": a new service worker script, found by the browser's update check.
    appendFileSync(swPath, `\n// e2e deploy ${Date.now()}\n`);
    await page.evaluate(async () => {
      await (await navigator.serviceWorker.getRegistration())?.update();
    });
    const toast = page.getByRole('status').filter({ hasText: 'New version available' });
    await expect(toast).toBeVisible({ timeout: 15_000 });

    await page.evaluate(() => {
      (window as { beforeReload?: boolean }).beforeReload = true;
    });
    await toast.getByRole('button', { name: 'Reload' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Reloading as soon as your changes are saved' }),
    ).toBeVisible();
    await page.waitForTimeout(1_500);
    expect(await page.evaluate(() => (window as { beforeReload?: boolean }).beforeReload)).toBe(
      true,
    );
    expect(
      await page.evaluate(async () =>
        Boolean((await navigator.serviceWorker.getRegistration())?.waiting),
      ),
    ).toBe(true);

    // The outbox drains, then the new version takes over and the page reloads by itself.
    const reloaded = page.waitForEvent('load');
    for (const route of held.splice(0)) await route.continue();
    await reloaded;
    await expect(page.getByRole('treegrid')).toBeVisible();
    expect(await page.evaluate(() => (window as { beforeReload?: boolean }).beforeReload)).toBe(
      undefined,
    );
    expect(
      await page.evaluate(async () =>
        Boolean((await navigator.serviceWorker.getRegistration())?.waiting),
      ),
    ).toBe(false);
    expect(await controlled(page)).toBe(true);
    const list = await myList(page, orgId);
    expect(list.tasks.map((t) => t.title)).toContain('Unsaved work');
  } finally {
    writeFileSync(swPath, original);
  }
});

/** "Deploy": a new service worker script, found by the browser's update check. */
async function deploy(page: Page) {
  appendFileSync(swPath, `\n// e2e deploy ${Date.now()}\n`);
  await page.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration())?.update();
  });
}

function hasWaitingWorker(page: Page) {
  return page.evaluate(async () =>
    Boolean((await navigator.serviceWorker.getRegistration())?.waiting),
  );
}

test('AC-4.7 the header "Update" chip outlives the toast and reloads, never while editing', async ({
  page,
}) => {
  await signInAs(page, uniqueEmail('pwa.chip'));
  await swActive(page);
  await page.reload();
  expect(await controlled(page)).toBe(true);
  await expect(page.getByRole('treegrid')).toBeVisible();
  const unsaved = await addUnsavedTask(page, 'Saved before the update');

  const original = readFileSync(swPath, 'utf8');
  try {
    await deploy(page);
    await expect(updateToast(page)).toBeVisible({ timeout: 15_000 });
    await expect(updateChip(page)).toBeVisible();
    await updateToast(page).getByRole('button', { name: 'Dismiss' }).click();
    await expect(updateToast(page)).toHaveCount(0);
    await expect(updateChip(page)).toBeVisible();

    await markDocument(page);
    await updateChip(page).click();
    await expect(deferredChip(page)).toBeVisible();

    // Saved, but a text editor has focus: the new version keeps waiting.
    await startEditing(page);
    await unsaved.release();
    await waitForPending(page, 0);
    await page.waitForTimeout(1_500);
    expect(await reloaded(page)).toBe(false);
    expect(await hasWaitingWorker(page)).toBe(true);

    const load = page.waitForEvent('load');
    await stopEditing(page);
    await load;
    expect(await reloaded(page)).toBe(true);
    await expect(page.getByRole('treegrid')).toBeVisible();
    expect(await hasWaitingWorker(page)).toBe(false);
    expect(await controlled(page)).toBe(true);
    await expect(updateChip(page)).toHaveCount(0);
    await expect(page.getByText('Saved before the update')).toBeVisible();
  } finally {
    writeFileSync(swPath, original);
  }
});
