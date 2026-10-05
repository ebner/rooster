import type { Page } from '@playwright/test';
import { signInAs, uniqueEmail } from './auth';
import { createTask, groupId, personalOrg } from './p3';
import { expect } from './test';

/** Phase 5 palette helpers: an English UI, a seeded Today group, palette locators. */

export async function englishUi(page: Page) {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      sessionStorage.setItem('e2e-init', '1');
      localStorage.setItem('rooster.locale', 'en');
    }
  });
}

export type Seed = string | { title: string; dueDate?: string };

/** Signs in and seeds `titles` into Today, in order; returns their ids. */
export async function seed(page: Page, name: string, titles: Seed[]) {
  await signInAs(page, uniqueEmail(name));
  const orgId = await personalOrg(page);
  const today = await groupId(page, orgId, 'Today');
  const ids: string[] = [];
  let afterId: string | null = null;
  for (const entry of titles) {
    const fields = typeof entry === 'string' ? { title: entry } : entry;
    const task = await createTask(page, orgId, {
      ...fields,
      groupId: today,
      afterId,
      beforeId: null,
    });
    ids.push(task.id);
    afterId = task.id;
  }
  await page.reload().catch(() => page.goto('/o/personal/my'));
  await expect(page.getByTestId('task-row').first()).toBeVisible({ timeout: 15_000 });
  return { orgId, today, ids };
}

export const palette = (page: Page) => page.getByTestId('palette');
export const paletteInput = (page: Page) => page.getByTestId('palette-input');
export const paletteTask = (page: Page, title: string | RegExp) =>
  page.getByTestId('palette-task').filter({ hasText: title });
export const paletteAction = (page: Page, label: string | RegExp) =>
  page.getByTestId('palette-action').filter({ hasText: label });
