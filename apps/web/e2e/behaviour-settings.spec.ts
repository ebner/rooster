import type { Page } from '@playwright/test';
import { apiCall, signInAs, uniqueEmail } from './support/auth';
import { createTask, groupId, myList, personalOrg, waitForSync } from './support/p3';
import { expect, test } from './support/test';

/** Phase 11 (FR-SET-2): Settings → Behaviour changes how the list behaves. */

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

async function prefs(page: Page) {
  const me = (await (await apiCall(page, 'GET', '/api/v1/me')).json()) as {
    prefs: { parseTitleDates: boolean; completeHideMs: number };
  };
  return me.prefs;
}

test('turning off "Recognise dates in task names" keeps “fri” in the title', async ({ page }) => {
  await signInAs(page, uniqueEmail('behaviour.dates'));
  const orgId = await personalOrg(page);
  await page.goto('/settings/behaviour');
  const toggle = page.getByRole('switch', { name: /Recognise dates in task names/ });
  await expect(toggle).toBeChecked();
  await page.getByText('Recognise dates in task names').click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved' }).first()).toBeVisible();
  await expect.poll(async () => (await prefs(page)).parseTitleDates).toBe(false);

  await page.goto('/o/personal/my');
  await page.getByRole('button', { name: 'Add task' }).first().click();
  await page.keyboard.type('Call Bob fri');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(row(page, 'Call Bob fri')).toBeVisible();
  await waitForSync(page);
  const bob = (await myList(page, orgId)).tasks.find((t) => t.title.startsWith('Call Bob'));
  expect(bob?.title).toBe('Call Bob fri');
  expect(bob?.dueDate).toBeNull();
});

test('"Hide completed tasks after: Until reload" keeps completed rows until the page reloads', async ({
  page,
}) => {
  await signInAs(page, uniqueEmail('behaviour.hide'));
  const orgId = await personalOrg(page);
  await createTask(page, orgId, {
    title: 'Water plants',
    groupId: await groupId(page, orgId, 'Today'),
  });
  await page.goto('/settings/behaviour');
  const choice = page.getByRole('radio', { name: 'Until reload' });
  await expect(page.getByRole('radio', { name: '1.5 s' })).toBeChecked();
  await page.getByText('Until reload', { exact: true }).click();
  await expect(choice).toBeChecked();
  await expect.poll(async () => (await prefs(page)).completeHideMs).toBe(10_000);

  await page.goto('/o/personal/my');
  const water = row(page, 'Water plants');
  await water.locator('label').first().click();
  await expect(water).toHaveAttribute('data-done', 'true');
  // Well past the 1.5 s and 3 s holds: still there, struck through.
  await page.waitForTimeout(4000);
  await expect(water).toBeVisible();
  await waitForSync(page);
  await page.reload();
  await expect(page.getByRole('treegrid')).toBeVisible();
  await expect(row(page, 'Water plants')).toHaveCount(0);

  // Back to 3 s: the row goes after the hold.
  await page.goto('/settings/behaviour');
  await page.getByText('3 s', { exact: true }).click();
  await expect.poll(async () => (await prefs(page)).completeHideMs).toBe(3000);
  await createTask(page, orgId, {
    title: 'Feed the cat',
    groupId: await groupId(page, orgId, 'Today'),
  });
  await page.goto('/o/personal/my');
  const cat = row(page, 'Feed the cat');
  await cat.locator('label').first().click();
  await expect(cat).toHaveAttribute('data-done', 'true');
  await page.waitForTimeout(2000);
  await expect(cat).toBeVisible();
  await expect(cat).toHaveCount(0, { timeout: 3000 });
});
