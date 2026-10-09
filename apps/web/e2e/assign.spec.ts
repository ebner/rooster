import type { Page } from '@playwright/test';
import type { Task } from '@rooster/core/schemas';
import { apiCall, signInAs, uniqueEmail } from './support/auth';
import { createTask, myList, waitForSync } from './support/p3';
import { sharedOrg } from './support/p6-people';
import { expect, test } from './support/test';

/** Phase 6, WP 6.1 (AC-6.1, AC-6.2, AC-6.4): assignment between two people of a shared org. */

const shots = process.env.ROOSTER_P6_SCREENSHOTS;

test.beforeEach(async ({ page }) => {
  if (shots) await page.setViewportSize({ width: 1440, height: 900 });
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

/** Selects a row in Navigate (focusing its title selects it). */
async function select(page: Page, title: string) {
  await row(page, title).locator('[data-focus-target]').focus();
  await expect(row(page, title)).toHaveAttribute('aria-selected', 'true');
}

async function task(page: Page, id: string): Promise<Task> {
  return (await (await apiCall(page, 'GET', `/api/v1/tasks/${id}`)).json()) as Task;
}

test('AC-6.1 A assigns a task to B with Tab+A; it leaves A’s list and tops B’s Inbox live', async ({
  page,
  browser,
}) => {
  const { a, b, slug, orgId, bId, bName } = await sharedOrg(page, browser, 'ac.sixone');
  await createTask(b, orgId, { title: 'B already has this' });
  const shipped = await createTask(a, orgId, { title: 'Ship the report' });
  await createTask(a, orgId, { title: 'Stays with A' });
  await a.goto(`/o/${slug}/my`);
  await b.goto(`/o/${slug}/my`);
  await expect(row(b, 'B already has this')).toBeVisible();
  await expect(row(b, 'Ship the report')).toHaveCount(0);

  await select(a, 'Ship the report');
  await a.keyboard.down('Tab');
  await a.keyboard.press('a');
  await a.keyboard.up('Tab');
  const picker = a.getByTestId('assignee-picker');
  await expect(picker).toBeVisible();
  if (shots) await a.screenshot({ path: `${shots}/1440-assignee-picker.png` });
  await picker.getByRole('combobox', { name: 'Filter people' }).fill('bertil');
  await a.keyboard.press('Enter');

  await expect(row(a, 'Ship the report')).toHaveCount(0);
  await expect(a.getByText(`Assigned to ${bName} · moved to their Inbox`)).toBeVisible();
  await expect(row(a, 'Stays with A')).toBeVisible();
  await waitForSync(a);
  expect((await task(a, shipped.id)).assigneeId).toBe(bId);

  // B: at the top of the Inbox, without a reload (SSE).
  await expect(row(b, 'Ship the report')).toBeVisible();
  await expect(b.getByTestId('task-row').first()).toContainText('Ship the report');
  const inbox = (await myList(b, orgId)).groups.find((g) => g.kind === 'inbox');
  const placed = (await myList(b, orgId)).tasks.find((t) => t.id === shipped.id);
  expect(placed?.placement?.groupId).toBe(inbox?.id);
});

test('AC-6.1 Undo of an assignment puts the task back in place', async ({ page, browser }) => {
  const { a, slug, orgId, bName } = await sharedOrg(page, browser, 'ac.undo');
  await createTask(a, orgId, { title: 'First' });
  await createTask(a, orgId, { title: 'Second' });
  await a.goto(`/o/${slug}/my`);
  await expect(row(a, 'First')).toBeVisible();
  const before = await a.getByTestId('task-row').allTextContents();
  await select(a, 'First');
  await a.keyboard.press('a');
  await a.getByTestId('assignee-picker').getByRole('option', { name: bName }).click();
  await expect(row(a, 'First')).toHaveCount(0);
  await a.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(row(a, 'First')).toBeVisible();
  expect(await a.getByTestId('task-row').allTextContents()).toEqual(before);
});

test('AC-6.2 a subtask assigned to B shows in B’s list with a breadcrumb until its parent is B’s too', async ({
  page,
  browser,
}) => {
  const { a, b, slug, orgId, bId, bName } = await sharedOrg(page, browser, 'ac.sixtwo');
  const parent = await createTask(a, orgId, { title: 'Plan the launch' });
  const child = await createTask(a, orgId, { title: 'Book the venue', parentId: parent.id });
  await apiCall(a, 'PATCH', `/api/v1/tasks/${child.id}`, { assigneeId: bId });

  await b.goto(`/o/${slug}/my`);
  await expect(row(b, 'Book the venue').getByTestId('row-breadcrumb')).toHaveText(
    'Plan the launch ›',
  );
  await expect(row(b, 'Plan the launch')).toHaveCount(0);

  // A sees B's avatar on the subtask (FR-TASK-10).
  await a.goto(`/o/${slug}/my`);
  await row(a, 'Plan the launch').locator('[data-chevron]').click();
  await expect(row(a, 'Book the venue').getByTestId('row-assignee')).toHaveAttribute(
    'data-user-id',
    bId,
  );

  // A assigns the parent to B: the orphan row goes, the subtask is under its parent.
  await select(a, 'Plan the launch');
  await a.keyboard.press('a');
  await a.getByTestId('assignee-picker').getByRole('option', { name: bName }).click();
  await waitForSync(a);
  await expect(row(b, 'Plan the launch')).toBeVisible();
  await expect(b.getByTestId('row-breadcrumb')).toHaveCount(0);
  const list = await myList(b, orgId);
  expect(list.tasks.find((t) => t.id === child.id)?.placement).toBeNull();
});

test('AC-6.4 removing B unassigns B’s tasks: they show under Unassigned in Everyone’s tasks', async ({
  page,
  browser,
}) => {
  const { a, b, slug, orgId, bName } = await sharedOrg(page, browser, 'ac.sixfour');
  await createTask(b, orgId, { title: 'Bertil’s errand' });
  await a.goto(`/o/${slug}/everyone`);
  const bSection = a.getByTestId('member-section').filter({ hasText: bName });
  await expect(bSection).toBeVisible();

  await a.goto(`/o/${slug}/settings`);
  await a.getByRole('button', { name: `Remove ${bName}` }).click();
  await a.getByRole('button', { name: 'Remove member' }).click();
  await expect(a.getByText(`Removed ${bName}`)).toBeVisible();

  await a.goto(`/o/${slug}/everyone`);
  await expect(a.getByTestId('member-section').filter({ hasText: bName })).toHaveCount(0);
  const outline = () =>
    a
      .locator('[data-list-root] [data-row-id]')
      .evaluateAll((els) =>
        els.flatMap((el) =>
          el.getAttribute('data-testid') === 'member-section'
            ? [`# ${el.getAttribute('data-assignee')}`]
            : el.getAttribute('data-testid') === 'task-row'
              ? [el.querySelector('[data-focus-target]')?.textContent ?? '']
              : [],
        ),
      );
  await expect.poll(outline).toEqual([expect.stringMatching(/^# /), '# none', 'Bertil’s errand']);
  await b.close();
});

test('FR-COL-6 the personal org has no assignment UI and no Everyone’s tasks', async ({ page }) => {
  await signInAs(page, uniqueEmail('col.six'));
  await page.goto('/o/personal/my');
  await page.getByRole('button', { name: 'Add task' }).first().click();
  await page.keyboard.type('Call @me');
  await expect(page.getByTestId('member-suggest')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await select(page, 'Call @me');
  await page.keyboard.press('a');
  await expect(page.getByTestId('assignee-picker')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Everyone/ })).toHaveCount(0);
  await page.goto('/o/personal/everyone');
  await expect(page).toHaveURL(/\/o\/personal\/my$/);
});
