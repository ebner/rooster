import type { Page } from '@playwright/test';
import { addDays } from '@rooster/core/dates';
import { expectAxeClean } from './support/a11y';
import { apiCall, signInAs, uniqueEmail } from './support/auth';
import { createTask, myList, personalOrg, waitForSync } from './support/p3';
import { viewerToday } from './support/p5-views';
import { expect, test } from './support/test';
import { swipe } from './support/touch';

/** Phase 13, WP 13.1 on phones (02 §10.1, §13): All organisations' rows, swipes and the FAB. */

const shots = process.env.ROOSTER_P13_SCREENSHOTS;

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

test('All · Today on a phone: rows from every org with their org; complete by swipe and checkbox; the FAB adds to the default org', async ({
  page,
}, testInfo) => {
  await signInAs(page, uniqueEmail('all.phone'));
  const personal = await personalOrg(page);
  const kestrel = (await (
    await apiCall(page, 'POST', '/api/v1/orgs', { name: 'Kestrel Lane' })
  ).json()) as { id: string };
  const today = await viewerToday(page);
  const late = await createTask(page, kestrel.id, {
    title: 'Call the caterer',
    dueDate: addDays(today, -1),
  });
  const slides = await createTask(page, kestrel.id, { title: 'Send the slides', dueDate: today });
  await createTask(page, personal, { title: 'Renew the passport', dueDate: today });

  await page.goto('/all/today');
  await expect(row(page, 'Renew the passport')).toBeVisible();
  const switcher = page.getByRole('navigation', { name: 'Views' });
  await expect(switcher.getByRole('link')).toHaveText(['Today', '7 days', 'Overdue']);
  await expect(switcher.getByRole('link', { name: 'Today' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  // Phones show the org's avatar; the row names the org.
  await expect(row(page, 'Send the slides').getByTestId('org-chip')).toBeVisible();
  await expect(row(page, 'Send the slides')).toHaveAttribute('aria-label', /in Kestrel Lane/);
  await expectAxeClean(page, 'all-today-phone');
  if (shots && testInfo.project.name === 'mobile') {
    await page.screenshot({ path: `${shots}/390-all-today.png` });
  }

  // A swipe right completes Kestrel's overdue task; the checkbox completes the other one.
  await swipe(page, row(page, 'Call the caterer'), 0.6);
  await expect(row(page, 'Call the caterer')).toHaveCount(0, { timeout: 5_000 });
  await row(page, 'Send the slides').locator('label').first().tap();
  await expect(row(page, 'Send the slides')).toHaveCount(0, { timeout: 5_000 });
  await waitForSync(page);
  const list = await myList(page, kestrel.id);
  expect(list.tasks.find((t) => t.id === late.id)?.completedAt).not.toBeNull();
  expect(list.tasks.find((t) => t.id === slides.id)?.completedAt).not.toBeNull();

  // The FAB adds to the default org (Personal), due today.
  await page.getByRole('button', { name: 'New task' }).tap();
  const input = page.locator('[data-list-input]');
  await expect(input).toBeFocused();
  await expect(page.getByTestId('draft-org-chip')).toBeVisible();
  await input.fill('Water the plants');
  const bar = page.getByTestId('accessory-bar');
  await bar.getByRole('button', { name: 'Next' }).click();
  await expect(row(page, 'Water the plants')).toBeVisible();
  await waitForSync(page);
  const plants = (await myList(page, personal)).tasks.find((t) => t.title === 'Water the plants');
  expect(plants?.dueDate).toBe(today);

  // The switcher moves between the All views; Overdue has no FAB.
  await page.locator('[data-list-input]').blur();
  await switcher.getByRole('link', { name: 'Overdue' }).tap();
  await expect(page).toHaveURL(/\/all\/overdue$/);
  await expect(page.getByRole('button', { name: 'New task' })).toHaveCount(0);
});
