import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { addDays } from '@rooster/core/dates';
import { clickRowBody, mod, myList, waitForSync } from './support/p3';
import { setupViews } from './support/p5-views';
import { expect, test } from './support/test';

/** Phase 5, WP 5.1 (AC-5.1): the smart views on desktop against the real server. */

const shots = process.env.ROOSTER_P5_SCREENSHOTS;

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
  page.getByTestId('task-row').filter({ hasText: title }).first();
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Main' });
const sectionNames = (page: Page) => page.getByTestId('section-header').locator('h2');

/** Navigate-mode keys need focus off any input. */
async function keys(page: Page, ...sequence: string[]) {
  for (const key of sequence) await page.keyboard.press(key);
}

test('AC-5.1 Today shows overdue and today tasks from all groups with a group chip; creating there sets due = today in the Inbox; completing there completes it in My tasks', async ({
  page,
}) => {
  const { orgId, today, groups, tasks } = await setupViews(page, 'ac.fiveone');
  await page.reload();
  // Sidebar badges (02 §2): My tasks and Today counts, Overdue in danger.
  const todayLink = sidebar(page).getByRole('link', { name: /^Today/ });
  await expect(todayLink).toContainText('3');
  await expect(sidebar(page).getByRole('link', { name: /^Overdue/ })).toContainText('1');
  await expect(sidebar(page).getByRole('link', { name: /^My tasks/ })).toContainText('5');
  await todayLink.click();
  await expect(page).toHaveURL(/\/o\/personal\/today$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Today');
  await expect(sectionNames(page)).toHaveText(['Overdue', 'Today']);
  await expect(page.getByTestId('task-row')).toHaveCount(3);
  await expect(
    row(page, 'Late report').getByTestId('group-chip').locator('[aria-hidden]'),
  ).toHaveText('Prio');
  await expect(
    row(page, 'Water plants').getByTestId('group-chip').locator('[aria-hidden]'),
  ).toHaveText('Today');
  await expect(
    row(page, 'Inbox call').getByTestId('group-chip').locator('[aria-hidden]'),
  ).toHaveText('Inbox');
  await expect(row(page, 'Someday idea')).toHaveCount(0);
  await expect(row(page, 'Dentist')).toHaveCount(0);
  if (shots) await page.screenshot({ path: `${shots}/1440-today.png` });

  // Creating in Today: due = today, in the Inbox.
  await page.getByRole('button', { name: 'Add task' }).click();
  await page.keyboard.type('Pay rent');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(row(page, 'Pay rent')).toBeVisible();
  await expect(row(page, 'Pay rent').getByTestId('group-chip').locator('[aria-hidden]')).toHaveText(
    'Inbox',
  );
  await waitForSync(page);
  let list = await myList(page, orgId);
  const created = list.tasks.find((t) => t.title === 'Pay rent');
  expect(created?.dueDate).toBe(today);
  expect(created?.placement?.groupId).toBe(groups.Inbox);

  // Completing in Today completes the task itself: gone from My tasks too.
  await row(page, 'Water plants').locator('label').first().click();
  await expect(row(page, 'Water plants')).toHaveCount(0, { timeout: 5_000 });
  await waitForSync(page);
  list = await myList(page, orgId);
  expect(list.tasks.find((t) => t.id === tasks['Water plants']?.id)?.completedAt).not.toBeNull();
  await sidebar(page)
    .getByRole('link', { name: /^My tasks/ })
    .click();
  await expect(page).toHaveURL(/\/o\/personal\/my$/);
  await expect(row(page, 'Late report')).toBeVisible();
  await expect(row(page, 'Water plants')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('My tasks');
});

test('G-sequences switch views; `>Group` places the task, Next 7 days inherits the day', async ({
  page,
}) => {
  const { orgId, today, groups } = await setupViews(page, 'views.keys');
  await page.reload();
  await expect(row(page, 'Late report')).toBeVisible();
  await keys(page, 'g', 'w');
  await expect(page).toHaveURL(/\/week$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Next 7 days');
  await expect(sectionNames(page)).toHaveCount(7);
  await expect(sectionNames(page).nth(0)).toHaveText('Today');
  await expect(sectionNames(page).nth(1)).toHaveText('Tomorrow');
  await expect(row(page, 'Dentist')).toBeVisible();
  // No drag handles: use D to re-date.
  await expect(page.locator('[data-drag-handle]')).toHaveCount(0);
  if (shots) await page.screenshot({ path: `${shots}/1440-week.png` });

  // "+ Add task" under Tomorrow, with `>prio` (prefix) highlighted and placed.
  await page.getByRole('button', { name: 'Add task' }).nth(1).click();
  await page.keyboard.type('Buy stamps >prio');
  await expect(page.locator('[data-list-input]').locator('..').locator('mark')).toHaveText('>prio');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await waitForSync(page);
  const list = await myList(page, orgId);
  const stamps = list.tasks.find((t) => t.title === 'Buy stamps');
  expect(stamps?.dueDate).toBe(addDays(today, 1));
  expect(stamps?.placement?.groupId).toBe(groups.Prio);

  await keys(page, 'Escape', 'g', 'o');
  await expect(page).toHaveURL(/\/overdue$/);
  await expect(page.getByTestId('task-row')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Add task' })).toHaveCount(0);
  await keys(page, 'g', 'n');
  await expect(page).toHaveURL(/\/nodate$/);
  await expect(row(page, 'Someday idea')).toBeVisible();
  await keys(page, 'g', 't');
  await expect(page).toHaveURL(/\/today$/);
  await keys(page, 'g', 'm');
  await expect(page).toHaveURL(/\/my$/);
});

test('the pane opens over a smart view and closes back to it', async ({ page }) => {
  await setupViews(page, 'views.pane');
  await page.goto('/o/personal/today');
  await clickRowBody(page, 'Inbox call');
  await expect(page).toHaveURL(/\/o\/personal\/t\//);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Today');
  await expect(sidebar(page).getByRole('link', { name: /^Today/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/o\/personal\/today$/);
});

test('an empty smart view shows its empty state, axe-clean', async ({ page }) => {
  await setupViews(page, 'views.empty');
  await page.goto('/o/personal/overdue');
  await expect(row(page, 'Late report')).toBeVisible();
  await row(page, 'Late report').locator('label').first().click();
  await expect(page.getByTestId('view-empty')).toContainText('Nothing overdue', {
    timeout: 5_000,
  });
  if (shots) await page.screenshot({ path: `${shots}/1440-empty.png` });
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' | ')}`),
  ).toEqual([]);
  // Undo (Mod+Z) brings it back.
  await page.keyboard.press(`${mod}+z`);
  await expect(row(page, 'Late report')).toBeVisible();
});
