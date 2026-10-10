import type { Page } from '@playwright/test';
import { myList, waitForSync } from './support/p3';
import { setupViews } from './support/p5-views';
import { expect, reload, test } from './support/test';

/** Phase 5, WP 5.1 on phones (02 §13): the view switcher tabs and the FAB in a smart view. */

const shots = process.env.ROOSTER_P5_SCREENSHOTS;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      sessionStorage.setItem('e2e-init', '1');
      localStorage.setItem('rooster.locale', 'en');
    }
  });
});

const row = (page: Page, title: string) =>
  page.getByTestId('task-row').filter({ hasText: title }).first();

test('the view switcher lists the smart views; the FAB creates in Today with due = today in the Inbox', async ({
  page,
}, testInfo) => {
  const { orgId, today, groups } = await setupViews(page, 'views.phone');
  await reload(page);
  const switcher = page.getByRole('navigation', { name: 'Views' });
  await expect(switcher.getByRole('link')).toHaveText([
    'My tasks',
    'Today',
    '7 days',
    'Overdue',
    'No date',
  ]);
  await switcher.getByRole('link', { name: 'Today' }).tap();
  await expect(page).toHaveURL(/\/today$/);
  await expect(switcher.getByRole('link', { name: 'Today' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  // The bottom nav keeps My tasks active under a smart view.
  await expect(
    page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'My tasks' }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(row(page, 'Late report')).toBeVisible();
  await expect(row(page, 'Water plants')).toBeVisible();
  const project = testInfo.project.name;
  if (shots && project === 'mobile') await page.screenshot({ path: `${shots}/390-today.png` });

  await page.getByRole('button', { name: 'New task' }).tap();
  const input = page.locator('[data-list-input]');
  await expect(input).toBeFocused();
  const bar = page.getByTestId('accessory-bar');
  await expect(bar).toBeVisible();
  // The accessory bar shows the inherited date and the Inbox.
  await expect(bar).toContainText('Today');
  await expect(bar).toContainText('Inbox');
  await input.fill('Phone task');
  await bar.getByRole('button', { name: 'Next' }).click();
  await expect(row(page, 'Phone task')).toBeVisible();
  await waitForSync(page);
  const created = (await myList(page, orgId)).tasks.find((t) => t.title === 'Phone task');
  expect(created?.dueDate).toBe(today);
  expect(created?.placement?.groupId).toBe(groups.Inbox);

  // Next 7 days and Overdue (no FAB there: no inline add).
  await page.locator('[data-list-input]').blur();
  await switcher.getByRole('link', { name: '7 days' }).tap();
  await expect(page).toHaveURL(/\/week$/);
  await expect(page.getByTestId('section-header')).toHaveCount(7);
  if (shots && project === 'mobile') await page.screenshot({ path: `${shots}/390-week.png` });
  await switcher.getByRole('link', { name: 'Overdue' }).tap();
  await expect(page).toHaveURL(/\/overdue$/);
  await expect(page.getByRole('button', { name: 'New task' })).toHaveCount(0);
  await switcher.getByRole('link', { name: 'No date' }).tap();
  await expect(row(page, 'Someday idea')).toBeVisible();
});

test('an empty Overdue view shows the empty state', async ({ page }, testInfo) => {
  await setupViews(page, 'views.phone.empty');
  await page.goto('/o/personal/overdue');
  await expect(row(page, 'Late report')).toBeVisible();
  await row(page, 'Late report').locator('label').first().tap();
  await expect(page.getByTestId('view-empty')).toContainText('Nothing overdue', {
    timeout: 5_000,
  });
  if (shots && testInfo.project.name === 'mobile') {
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${shots}/390-empty.png` });
  }
});
