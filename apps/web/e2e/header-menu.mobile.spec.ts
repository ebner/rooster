import type { Page } from '@playwright/test';
import { signInAs, uniqueEmail } from './support/auth';
import { createTask, groupId, personalOrg } from './support/p3';
import { expect, test } from './support/test';

/** Phase 11: the list's ⋯ items in the phone header (02 §2, §13.1), and printing on a phone. */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      sessionStorage.setItem('e2e-init', '1');
      localStorage.setItem('rooster.locale', 'en');
    }
    (window as unknown as { printed: number }).printed = 0;
    window.print = () => {
      (window as unknown as { printed: number }).printed += 1;
    };
  });
});

const row = (page: Page, title: string) =>
  page.getByTestId('task-row').filter({ hasText: title }).first();

async function openMenu(page: Page) {
  await page.getByTestId('mobile-header').getByRole('button', { name: 'More' }).click();
  await expect(page.getByRole('menu')).toBeVisible();
}

test('the phone ⋯ has the list items; Collapse all, Expand all and Print work', async ({
  page,
}) => {
  await signInAs(page, uniqueEmail('menu.phone'));
  const orgId = await personalOrg(page);
  await createTask(page, orgId, {
    title: 'Reply to Anna',
    groupId: await groupId(page, orgId, 'Today'),
  });
  await page.reload();
  await expect(row(page, 'Reply to Anna')).toBeVisible();

  await openMenu(page);
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'Add group' })).toBeVisible();
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Show completed' })).toBeVisible();
  // No keyboard hints on a phone.
  await expect(menu.locator('kbd')).toHaveCount(0);
  await menu.getByRole('menuitem', { name: 'Collapse all groups' }).click();
  await expect(row(page, 'Reply to Anna')).toHaveCount(0);
  await openMenu(page);
  await page.getByRole('menu').getByRole('menuitem', { name: 'Expand all groups' }).click();
  await expect(row(page, 'Reply to Anna')).toBeVisible();

  await openMenu(page);
  await page.getByRole('menu').getByRole('menuitem', { name: 'Print' }).click();
  expect(await page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(1);

  await page.emulateMedia({ media: 'print' });
  await expect(page.getByTestId('mobile-header')).toBeHidden();
  await expect(page.getByRole('navigation', { name: 'Views' })).toBeHidden();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeHidden();
  await expect(page.locator('[data-fab]')).toBeHidden();
  await expect(page.locator('[data-print-title]')).toBeVisible();
  await expect(row(page, 'Reply to Anna')).toBeVisible();
  await page.emulateMedia({ media: 'screen' });
  await expect(page.getByTestId('mobile-header')).toBeVisible();
});
