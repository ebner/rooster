import type { Page } from '@playwright/test';
import { apiCall, signInAs, uniqueEmail } from './support/auth';
import { createTask, groupId, mod, myList, personalOrg, waitForSync } from './support/p3';
import { expect, test } from './support/test';

/** Phase 11: the list header's ⋯ menu (02 §2) and printing the list, on desktop. */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      sessionStorage.setItem('e2e-init', '1');
      localStorage.setItem('rooster.locale', 'en');
    }
    // window.print opens a blocking dialog: count the calls instead.
    (window as unknown as { printed: number }).printed = 0;
    window.print = () => {
      (window as unknown as { printed: number }).printed += 1;
    };
  });
});

const row = (page: Page, title: string) =>
  page.getByTestId('task-row').filter({ hasText: title }).first();
const normalGroups = (page: Page) =>
  page.getByTestId('group-header').and(page.locator(':not([data-inbox])'));
const menuItem = (page: Page, name: string | RegExp) =>
  page.getByRole('menu').getByRole('menuitem', { name });
const printed = (page: Page) =>
  page.evaluate(() => (window as unknown as { printed: number }).printed);

async function openMenu(page: Page) {
  await page.getByTestId('list-menu').click();
  await expect(page.getByRole('menu')).toBeVisible();
}

async function seed(page: Page, name: string) {
  await signInAs(page, uniqueEmail(name));
  const orgId = await personalOrg(page);
  const today = await groupId(page, orgId, 'Today');
  const prio = await groupId(page, orgId, 'Prio');
  const parent = await createTask(page, orgId, { title: 'Plan the offsite', groupId: today });
  await createTask(page, orgId, { title: 'Book the venue', parentId: parent.id });
  await createTask(page, orgId, { title: 'Reply to Anna', groupId: today, dueDate: '2030-01-04' });
  const done = await createTask(page, orgId, { title: 'Send the slides', groupId: prio });
  const completed = await apiCall(page, 'POST', `/api/v1/tasks/${done.id}/complete`, {
    completed: true,
  });
  expect(completed.ok(), await completed.text()).toBe(true);
  const expanded = await apiCall(page, 'PUT', `/api/v1/tasks/${parent.id}/expanded`);
  expect(expanded.ok(), await expanded.text()).toBe(true);
  await page.reload();
  await expect(row(page, 'Reply to Anna')).toBeVisible();
  return { orgId };
}

test('the ⋯ menu: collapse all, expand all, show completed and add group', async ({ page }) => {
  const { orgId } = await seed(page, 'menu.desk');

  await openMenu(page);
  await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText([
    /Add group/,
    /Collapse all groups/,
    /Expand all groups/,
    /Export JSON/,
    /Export Markdown/,
    /Print/,
  ]);
  await menuItem(page, /Collapse all groups/).click();
  await expect(normalGroups(page).first()).toHaveAttribute('aria-expanded', 'false');
  for (const header of await normalGroups(page).all()) {
    await expect(header).toHaveAttribute('aria-expanded', 'false');
  }
  await expect(row(page, 'Reply to Anna')).toHaveCount(0);
  await waitForSync(page);
  expect(
    (await myList(page, orgId)).groups.filter((g) => g.kind === 'normal').every((g) => g.collapsed),
  ).toBe(true);

  await openMenu(page);
  await menuItem(page, /Expand all groups/).click();
  await expect(row(page, 'Reply to Anna')).toBeVisible();
  for (const header of await normalGroups(page).all()) {
    await expect(header).toHaveAttribute('aria-expanded', 'true');
  }

  // Show completed mirrors the header toggle.
  await expect(row(page, 'Send the slides')).toHaveCount(0);
  await openMenu(page);
  const show = page.getByRole('menuitemcheckbox', { name: /Show completed/ });
  await expect(show).toHaveAttribute('aria-checked', 'false');
  await show.click();
  await expect(row(page, 'Send the slides')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show completed', pressed: true })).toBeVisible();
  await openMenu(page);
  await expect(page.getByRole('menuitemcheckbox', { name: /Show completed/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.keyboard.press('Escape');

  // Add group: at the end, its name in edit.
  const before = await page.getByTestId('group-header').count();
  await openMenu(page);
  await menuItem(page, 'Add group').click();
  await expect(page.getByTestId('group-header')).toHaveCount(before + 1);
  const name = page.getByRole('textbox', { name: 'Group name' });
  await expect(name).toBeFocused();
  await page.keyboard.type('Someday');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('group-header').last()).toContainText('Someday');
  await waitForSync(page);
  expect((await myList(page, orgId)).groups.map((g) => g.name)).toContain('Someday');
});

test('Shift+←/→ collapse and expand every group from the keyboard', async ({ page }) => {
  await seed(page, 'menu.keys');
  await row(page, 'Reply to Anna').locator('[data-drag-handle]').click();
  await page.keyboard.press('Shift+ArrowLeft');
  await expect(row(page, 'Reply to Anna')).toHaveCount(0);
  for (const header of await normalGroups(page).all()) {
    await expect(header).toHaveAttribute('aria-expanded', 'false');
  }
  // The cursor moved to the folded group's header, so the keys keep working.
  await expect(page.getByTestId('group-header').filter({ hasText: 'Today' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('Shift+ArrowRight');
  await expect(row(page, 'Reply to Anna')).toBeVisible();
});

test('a smart view’s menu has no group items; the menu is reachable by keyboard', async ({
  page,
}) => {
  await seed(page, 'menu.smart');
  await page.goto('/o/personal/week');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Next 7 days');
  const trigger = page.getByTestId('list-menu');
  await trigger.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem')).toHaveText([/Export JSON/, /Export Markdown/, /Print/]);
  await expect(menu.getByRole('menuitemcheckbox', { name: /Show completed/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});

test('Export downloads the org as Markdown', async ({ page }) => {
  await seed(page, 'menu.export');
  await openMenu(page);
  const download = page.waitForEvent('download');
  await menuItem(page, 'Export Markdown').click();
  expect((await download).suggestedFilename()).toMatch(/\.md$/);
});

test('Print prints the list only: no sidebar, header, toolbars or pane', async ({ page }) => {
  await seed(page, 'menu.print');
  await openMenu(page);
  await menuItem(page, /Print/).click();
  expect(await printed(page)).toBe(1);
  await row(page, 'Reply to Anna').locator('[data-drag-handle]').click();
  await page.keyboard.press(`${mod}+p`);
  expect(await printed(page)).toBe(2);

  // Show completed, open the pane, then look at the page as the printer does.
  await page.keyboard.press('Shift+H');
  await expect(row(page, 'Send the slides')).toBeVisible();
  await page.keyboard.press('O');
  await expect(page.locator('[data-pane-root]')).toBeVisible();
  await page.emulateMedia({ media: 'print' });

  await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden();
  await expect(page.locator('[data-pane-root]')).toBeHidden();
  await expect(page.getByTestId('list-menu')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Add task' }).first()).toBeHidden();
  await expect(page.locator('[data-print-title]')).toBeVisible();
  await expect(page.locator('[data-print-title]')).toContainText('My tasks');
  await expect(page.getByRole('heading', { level: 1 })).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Today', level: 2 })).toBeVisible();
  await expect(row(page, 'Reply to Anna')).toBeVisible();
  await expect(row(page, 'Book the venue')).toBeVisible();
  const box = (title: string) =>
    row(page, title)
      .locator('label')
      .first()
      .evaluate((el) => getComputedStyle(el, '::before').content);
  expect(await box('Reply to Anna')).toBe('"☐"');
  expect(await box('Send the slides')).toBe('"☑"');
  // Subtasks stay indented under their parent.
  const indent = async (title: string) =>
    (await row(page, title).locator('[data-focus-target]').boundingBox())?.x ?? 0;
  expect(await indent('Book the venue')).toBeGreaterThan(await indent('Plan the offsite'));
  // Nothing clips the list to one screen.
  const overflow = await page.evaluate(() => getComputedStyle(document.body).overflow);
  expect(overflow).toBe('visible');

  await page.emulateMedia({ media: 'screen' });
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
});
