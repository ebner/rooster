import type { Page } from '@playwright/test';
import { expectAxeClean, seedA11yList } from './support/a11y';
import { apiCall, signInAs, uniqueEmail } from './support/auth';
import { expect, test } from './support/test';
import { longPress } from './support/touch';

/**
 * WP 11.3, AC-11.3 on phones (iPhone 15 WebKit, Pixel 8): axe on the phone frame, the sheets, the FAB with the accessory bar, selection mode, the detail sheet,
 * the inbox and the settings index and pages.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      sessionStorage.setItem('e2e-init', '1');
      localStorage.setItem('rooster.locale', 'en');
    }
  });
});

const row = (page: Page, title: string) =>
  page
    .getByTestId('task-row')
    .filter({ has: page.locator('[data-focus-target]').getByText(title, { exact: true }) });

/** Scrolls the list's scroller to its end. */
async function scrollToEnd(page: Page) {
  await page.evaluate(() => {
    let el = document.querySelector('[data-list-root]')?.parentElement ?? null;
    while (el && el.scrollHeight <= el.clientHeight) el = el.parentElement;
    el?.scrollTo({ top: el.scrollHeight });
  });
}

const primaryNav = (page: Page) => page.getByRole('navigation', { name: 'Primary' });

test('AC-11.3 axe on phones: sign-in', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'Continue with Dev login' })).toBeVisible();
  await expectAxeClean(page, 'login (phone)');
});

test('AC-11.3 axe on phones: the list, its sheets, the FAB and selection mode', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signInAs(page, uniqueEmail('a11y.phone'));
  const seed = await seedA11yList(page);
  await page.goto(`/o/${seed.slug}/my`);
  await expect(row(page, 'Step 5')).toBeVisible({ timeout: 15_000 });
  await expect(primaryNav(page)).toBeVisible();
  // The FAB floats over the list (02 §13.2): mid-scroll it covers part of whichever row is
  // under it. At the end of the list, the list's bottom padding must keep every row clear of it.
  await scrollToEnd(page);
  await expectAxeClean(page, 'my tasks (phone)');

  for (const view of ['today', 'week', 'overdue', 'nodate'] as const) {
    await page.goto(`/o/${seed.slug}/${view}`);
    await expect(page.getByRole('treegrid').or(page.getByTestId('view-empty'))).toBeVisible();
    await scrollToEnd(page);
    await expectAxeClean(page, `smart view ${view} (phone)`);
  }
  await page.goto(`/o/${seed.slug}/my`);
  await expect(row(page, 'Book dentist')).toBeVisible();

  // The view switcher and the org switcher sheet.
  await page.getByTestId('org-switcher').click();
  const orgs = page.getByRole('dialog', { name: 'Organisations' });
  await expect(orgs).toBeVisible();
  await expectAxeClean(page, 'org switcher sheet');
  await page.keyboard.press('Escape');
  await expect(orgs).toHaveCount(0);

  // The FAB opens a draft with the accessory bar.
  await page.getByRole('button', { name: 'New task' }).tap();
  await expect(page.getByTestId('accessory-bar')).toBeVisible();
  await expectAxeClean(page, 'FAB draft with the accessory bar');
  await page.getByTestId('accessory-bar').getByRole('button', { name: 'Date' }).click();
  const dateSheet = page.getByRole('dialog', { name: 'Due date' });
  await expect(dateSheet).toBeVisible();
  await expectAxeClean(page, 'quick date sheet');
  await page.keyboard.press('Escape');
  await expect(dateSheet).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Selection mode: the selection header and the bulk bar.
  await row(page, 'Call Bob').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await longPress(page, row(page, 'Call Bob'));
  await expect(page.getByTestId('selection-header')).toContainText('1 selected');
  // axe counts targets scrolled out of the list's scroller as covered by the fixed bar.
  await scrollToEnd(page);
  await expectAxeClean(page, 'selection mode');
  await page.getByTestId('selection-header').getByRole('button', { name: 'Done' }).click();
  await expect(page.getByTestId('selection-header')).toHaveCount(0);

  // The detail sheet with description, subtasks, comments, activity and attachments.
  await row(page, 'Book dentist').click();
  const sheet = page.getByTestId('detail-pane');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('referral.txt').first()).toBeVisible();
  await expectAxeClean(page, 'detail sheet');
  await page.getByTestId('sheet-due').click();
  await expect(page.getByRole('dialog', { name: 'Due date' })).toBeVisible();
  await expectAxeClean(page, 'detail sheet: date sheet with Repeat and Reminders');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Add tag' }).click();
  await expect(page.getByRole('dialog', { name: 'Tags' })).toBeVisible();
  await expectAxeClean(page, 'tag sheet');
});

test('AC-11.3 axe on phones: Everyone, the inbox and settings', async ({ page }) => {
  test.setTimeout(180_000);
  await signInAs(page, uniqueEmail('a11y.phone.settings'));
  const created = await apiCall(page, 'POST', '/api/v1/orgs', { name: 'Harbour' });
  const org = (await created.json()) as { id: string; slug: string };
  await apiCall(page, 'POST', `/api/v1/orgs/${org.id}/tasks`, { title: 'Fix the jetty' });
  await page.waitForLoadState('networkidle');
  // WebKit can report the first navigation as interrupted by the app's own route settle.
  await page.goto(`/o/${org.slug}/everyone`).catch(() => page.goto(`/o/${org.slug}/everyone`));
  await expect(row(page, 'Fix the jetty')).toBeVisible({ timeout: 15_000 });
  await expectAxeClean(page, 'everyone (phone)');

  await page.goto('/inbox');
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await expectAxeClean(page, 'inbox (phone)');

  await page.goto('/settings');
  await expect(page.getByRole('link', { name: 'Behaviour' })).toBeVisible();
  await expectAxeClean(page, 'settings index (phone)');
  for (const section of ['profile', 'behaviour', 'notifications', 'calendar', 'data', 'security']) {
    await page.goto(`/settings/${section}`);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    await expectAxeClean(page, `settings ${section} (phone)`);
  }
  await page.goto(`/o/${org.slug}/settings`);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await expectAxeClean(page, 'org settings (phone)');
});
