import type { Page, Route } from '@playwright/test';
import { waitForPending } from './pwa';
import { expect } from './test';

/** FR-PWA-6 helpers: the update toast, the header chip, held saves and reload detection. */

export function updateToast(page: Page) {
  return page.getByRole('status').filter({ hasText: 'New version available' });
}

export function updateChip(page: Page) {
  return page.getByRole('button', { name: 'Update – a new version is available' });
}

export function deferredChip(page: Page) {
  return page.getByRole('button', { name: 'Reloading when saved…' });
}

/** Marks the current document; `reloaded` is true once a new document replaced it. */
export async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as { beforeReload?: boolean }).beforeReload = true;
  });
}

export async function reloaded(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as { beforeReload?: boolean }).beforeReload !== true);
}

/**
 * Adds a task whose create the server does not answer yet, so the outbox holds one op until
 * `release()`; later creates pass.
 */
export async function addUnsavedTask(page: Page, title: string) {
  const held: Route[] = [];
  let holding = true;
  await page.route('**/api/v1/orgs/*/tasks', (route) => {
    if (holding && route.request().method() === 'POST') held.push(route);
    else void route.continue();
  });
  await page.getByRole('button', { name: 'Add task' }).first().click();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect.poll(() => held.length).toBe(1);
  await waitForPending(page, 1);
  return {
    release: async () => {
      holding = false;
      for (const route of held.splice(0)) await route.continue();
    },
  };
}

/** Puts focus in a text editor (a new task's title), as a user typing would. */
export async function startEditing(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Add task' }).first().click();
  await expect
    .poll(() => page.evaluate(() => document.activeElement instanceof HTMLInputElement))
    .toBe(true);
}

export async function stopEditing(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}
