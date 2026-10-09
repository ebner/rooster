import type { Page } from '@playwright/test';
import type { Task } from '@rooster/core/schemas';
import { apiCall, signInAs, uniqueEmail } from './support/auth';
import { createTask, waitForSync } from './support/p3';
import { sharedOrg } from './support/p6-people';
import { expect, test } from './support/test';
import { longPress } from './support/touch';

/** Phase 6 on phones (02 §13): the Everyone tab and the assignee sheet. */

const shots = process.env.ROOSTER_P6_SCREENSHOTS;

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
    .filter({ has: page.locator('[data-focus-target]').getByText(title, { exact: true }) })
    .first();

test('the Everyone tab shows sections per person; selection mode assigns through the sheet', async ({
  page,
  browser,
}, testInfo) => {
  const { a, slug, orgId, aId, bId, bName } = await sharedOrg(page, browser, 'ev.phone');
  const loose = await createTask(a, orgId, { title: 'Phone errand', assigneeId: null });
  await a.goto(`/o/${slug}/my`);
  const switcher = a.getByRole('navigation', { name: 'Views' });
  await expect(switcher.getByRole('link')).toHaveText([
    'My tasks',
    'Today',
    '7 days',
    'Overdue',
    'No date',
    'Everyone',
  ]);
  await switcher.getByRole('link', { name: 'Everyone' }).tap();
  await expect(a).toHaveURL(new RegExp(`/o/${slug}/everyone$`));
  const sections = a.getByTestId('member-section');
  await expect(sections).toHaveCount(3);
  await expect(sections.first()).toHaveAttribute('data-assignee', aId);
  await expect(sections.last()).toHaveAttribute('data-assignee', 'none');
  await expect(row(a, 'Phone errand')).toBeVisible();
  if (shots && testInfo.project.name === 'mobile') {
    await a.screenshot({ path: `${shots}/390-everyone.png` });
  }

  // Long-press selects; Assign (in place of Move) opens the sheet.
  await longPress(a, row(a, 'Phone errand'));
  await expect(a.getByTestId('selection-header')).toBeVisible();
  await a.getByRole('button', { name: 'Assign' }).tap();
  const sheet = a.getByTestId('assignee-sheet');
  await expect(sheet).toBeVisible();
  if (shots && testInfo.project.name === 'mobile') {
    await a.screenshot({ path: `${shots}/390-assignee-sheet.png` });
  }
  await sheet.getByRole('button', { name: bName }).tap();
  await expect(sheet).toHaveCount(0);
  await waitForSync(a);
  await expect
    .poll(
      async () =>
        ((await (await apiCall(a, 'GET', `/api/v1/tasks/${loose.id}`)).json()) as Task).assigneeId,
    )
    .toBe(bId);
  await expect(a.locator(`[data-testid="member-section"][data-assignee="${bId}"]`)).toBeVisible();
});

test('a personal org has no Everyone tab', async ({ page }) => {
  await signInAs(page, uniqueEmail('ev.phone.solo'));
  const switcher = page.getByRole('navigation', { name: 'Views' });
  await expect(switcher.getByRole('link')).toHaveText([
    'My tasks',
    'Today',
    '7 days',
    'Overdue',
    'No date',
  ]);
});
