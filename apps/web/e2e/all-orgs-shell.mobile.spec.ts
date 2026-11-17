import type { Page } from '@playwright/test';
import { expectAxeClean } from './support/a11y';
import { apiCall, signInAs, uniqueEmail } from './support/auth';
import { expect, reload, test } from './support/test';
import { pressAndSlide, swipe } from './support/touch';

/**
 * Phase 13, WP 13.1 on phones (02 §13.1, ADR 0073 A7): All organisations is the first entry of
 * the org sheet and of the header's swipe order, and a switch keeps Today, 7 days and Overdue.
 */

const shots = process.env.ROOSTER_P13_SCREENSHOTS;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      sessionStorage.setItem('e2e-init', '1');
      localStorage.setItem('rooster.locale', 'en');
    }
  });
});

/** Personal plus Garden club: All organisations is offered from the second org on. */
async function setup(page: Page, name: string): Promise<string> {
  await signInAs(page, uniqueEmail(name));
  const res = await apiCall(page, 'POST', '/api/v1/orgs', { name: 'Garden club' });
  expect(res.status()).toBe(201);
  const { slug } = (await res.json()) as { slug: string };
  await reload(page);
  return slug;
}

const sheet = (page: Page) => page.getByRole('dialog', { name: 'Organisations' });
const switcher = (page: Page) => page.getByTestId('org-switcher');

test('ADR 0073 A7 the org sheet lists All organisations first; it opens All · Today from My tasks', async ({
  page,
}) => {
  await setup(page, 'all.sheet');
  await expect(switcher(page)).toContainText('Personal');
  await switcher(page).click();
  const options = sheet(page).locator('[data-org-option]');
  await expect(options).toHaveText([/All organisations$/, /Personal$/, /Garden club$/]);
  await expect(sheet(page).getByRole('button', { name: 'Personal' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.waitForTimeout(300);
  if (shots) await page.screenshot({ path: `${shots}/390-org-sheet-all.png` });
  await expectAxeClean(page, 'org sheet with All organisations');
  // My tasks has no All counterpart: the switch lands on Today.
  await sheet(page).getByRole('button', { name: 'All organisations' }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/all\/today$/);
});

test('ADR 0073 A7 a swipe right from the first org goes to All organisations and keeps the view', async ({
  page,
}) => {
  await setup(page, 'all.swipe');
  await page.goto('/o/personal/week');
  await expect(switcher(page)).toContainText('Personal');
  // All organisations counts in the dots: All, Personal, Garden club.
  await expect(page.getByTestId('org-dots').locator('span')).toHaveCount(3);
  await swipe(page, switcher(page), 0.9);
  await expect(page).toHaveURL(/\/all\/week$/);
});

test('ADR 0073 A7 press-and-slide onto All organisations', async ({ page }) => {
  await setup(page, 'all.slide');
  await page.goto('/o/personal/overdue');
  await expect(switcher(page)).toContainText('Personal');
  await pressAndSlide(
    page,
    switcher(page),
    sheet(page).getByRole('button', { name: 'All organisations' }),
  );
  await expect(sheet(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/all\/overdue$/);
});

test('ADR 0073 A7 on All organisations the header shows it, and a switch to an org keeps the view', async ({
  page,
}) => {
  const slug = await setup(page, 'all.header');
  await page.goto('/all/week');
  await expect(switcher(page)).toHaveAccessibleName('All organisations, switch organisation');
  await expect(switcher(page)).toContainText('All organisations');
  const views = page.getByRole('navigation', { name: 'Views' });
  await expect(views.getByRole('link')).toHaveText(['Today', '7 days', 'Overdue']);
  await expect(views.getByRole('link', { name: '7 days' })).toHaveAttribute('aria-current', 'page');
  if (shots) await page.screenshot({ path: `${shots}/390-all-header.png` });
  // No org here: the ⋯ menu has no Organisation settings.
  await page.getByRole('button', { name: 'More' }).click();
  await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Organisation settings' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await switcher(page).click();
  await expect(sheet(page).getByRole('button', { name: 'All organisations' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await sheet(page).getByRole('button', { name: 'Garden club' }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${slug}/week$`));
  // And a swipe left from All organisations lands on the first org.
  await page.goto('/all/today');
  await expect(switcher(page)).toContainText('All organisations');
  await swipe(page, switcher(page), -0.9);
  await expect(page).toHaveURL(/\/o\/personal[^/]*\/today$/);
});
