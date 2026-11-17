import type { Page } from '@playwright/test';
import type { SavedView, Tag, Task } from '@rooster/core/schemas';
import { apiCall } from './support/auth';
import { createTask, waitForSync } from './support/p3';
import { sharedOrg } from './support/p6-people';
import { expect, test } from './support/test';

/**
 * Phase 13 on phones (02 §10.2, §13): a view in the switcher after Everyone, its query in a
 * sheet from the header, and the FAB adding to its first section.
 */

const shots = process.env.ROOSTER_P13_SCREENSHOT_DIR;

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

test('the view’s chips in a sheet; the FAB adds to the first section with the view’s tag', async ({
  page,
  browser,
}, testInfo) => {
  const { a, slug, orgId, aId } = await sharedOrg(page, browser, 'views.phone');
  const tag = (await (
    await apiCall(a, 'POST', `/api/v1/orgs/${orgId}/tags`, { name: 'juniper' })
  ).json()) as Tag;
  await createTask(a, orgId, { title: 'Dated juniper', tagIds: [tag.id], dueDate: '2099-03-01' });
  await createTask(a, orgId, { title: 'Undated juniper', tagIds: [tag.id] });
  const view = (await (
    await apiCall(a, 'POST', `/api/v1/orgs/${orgId}/views`, {
      name: 'Juniper',
      shared: true,
      query: { tags: [tag.id], tagMode: 'any', assignee: 'anyone', due: 'any', status: 'open' },
    })
  ).json()) as SavedView;

  await a.goto(`/o/${slug}/v/${view.id}`);
  await expect(row(a, 'Dated juniper')).toBeVisible();
  await expect(a.getByTestId('view-counts')).toContainText('2 open · 0 done');
  if (shots && testInfo.project.name === 'mobile') {
    await a.screenshot({ path: `${shots}/390-view.png` });
  }

  // The header's filter button opens the sheet: name, tags, person, due, status, sharing.
  await a.getByTestId('view-filters').tap();
  const sheet = a.getByTestId('view-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('Everyone in Harbour can see these tasks anyway');
  if (shots && testInfo.project.name === 'mobile') {
    // After the sheet's slide-in.
    await a.waitForTimeout(400);
    await a.screenshot({ path: `${shots}/390-view-sheet.png` });
  }
  await sheet.getByRole('button', { name: 'No date' }).tap();
  await expect
    .poll(async () => await (await apiCall(a, 'GET', `/api/v1/orgs/${orgId}/views`)).json())
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({ query: expect.objectContaining({ due: 'none' }) }),
      ]),
    );
  await a.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(row(a, 'Dated juniper')).toHaveCount(0);
  await expect(row(a, 'Undated juniper')).toBeVisible();

  // The FAB: a new row at the top of the first section (mine), created with the tag.
  await a.getByRole('button', { name: 'New task' }).tap();
  await a.keyboard.type('Phone juniper');
  await a.keyboard.press('Enter');
  await a.keyboard.press('Escape');
  await waitForSync(a);
  const tasks = (await (await apiCall(a, 'GET', `/api/v1/views/${view.id}/tasks`)).json()) as {
    items: Task[];
  };
  const created = tasks.items.find((t) => t.title === 'Phone juniper');
  expect(created?.tagIds).toEqual([tag.id]);
  expect(created?.assigneeId).toBe(aId);
});
