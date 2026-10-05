import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/**
 * Phase 1 screens in fixture mode (no server). Screenshots land in
 * ROOSTER_SCREENSHOT_DIR when set (for design review), else in the test output.
 */
const wcag = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      sessionStorage.setItem('e2e-init', '1');
      localStorage.setItem('rooster.locale', 'en');
      localStorage.removeItem('rooster.sidebar.collapsed');
    }
  });
});

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(wcag).analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' | ')}`),
  ).toEqual([]);
}

function screenshotPath(name: string, outputPath: (name: string) => string): string {
  const dir = process.env.ROOSTER_SCREENSHOT_DIR;
  return dir ? `${dir}/${name}.png` : outputPath(`${name}.png`);
}

for (const width of [1440, 390] as const) {
  test(`shell at ${width} px renders the sidebar per 02 §2 and is axe-clean`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
    await page.goto('/o/personal/my');
    await expect(page.getByRole('heading', { level: 1, name: /My tasks/ })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Today' })).toBeVisible();
    const sidebar = page.getByRole('navigation', { name: 'Main' });
    if (width < 768) {
      await expect(sidebar).toHaveCount(0);
      await page.getByRole('button', { name: 'Open navigation' }).click();
      await expect(page.getByRole('dialog', { name: 'Main' })).toBeVisible();
      await page.waitForTimeout(250);
    }
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('region', { name: 'Personal' })).toBeVisible();
    await expect(nav.getByRole('region', { name: 'Northwind' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'My tasks' }).first()).toHaveAttribute(
      'aria-current',
      'page',
    );
    await page.screenshot({
      path: screenshotPath(`shell-${width}`, (n) => testInfo.outputPath(n)),
    });
    await expectNoAxeViolations(page);
  });
}

test('AC-1.5 (fixture) reordering an org with the keyboard moves it in the sidebar', async ({
  page,
}) => {
  await page.goto('/o/personal/my');
  const nav = page.getByRole('navigation', { name: 'Main' });
  const sections = nav.getByRole('region');
  await expect(sections.first()).toHaveAccessibleName('Personal');
  await nav.getByRole('button', { name: 'Reorder Northwind' }).focus();
  const live = page.getByRole('status').filter({ hasText: /Northwind/ });
  await page.keyboard.press('Space');
  await expect(live).toHaveText('Picked up Northwind. Position 2 of 3.');
  await page.keyboard.press('ArrowUp');
  await expect(live).toHaveText('Northwind is at position 1 of 3.');
  await page.keyboard.press('Space');
  await expect(sections.first()).toHaveAccessibleName('Northwind');
  await expect(
    page.getByRole('status').filter({ hasText: 'Moved Northwind to position 1 of 3.' }),
  ).toHaveCount(1);
});

test('rail state survives a reload (Ctrl+\\)', async ({ page }) => {
  await page.goto('/o/personal/my');
  await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible();
  await page.keyboard.press('Control+Backslash');
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
});

test('creating an org from the sidebar popover opens it', async ({ page }) => {
  await page.goto('/o/personal/my');
  await page.getByRole('button', { name: 'New organisation' }).click();
  const dialog = page.getByRole('dialog', { name: 'New organisation' });
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Garden club');
  await dialog.getByRole('option', { name: '🌱' }).click();
  await expectNoAxeViolations(page);
  await dialog.getByRole('button', { name: 'Create organisation' }).click();
  await expect(page).toHaveURL(/\/o\/garden-club\/my$/);
  await expect(page.getByRole('heading', { level: 1, name: /Garden club/ })).toBeVisible();
});

for (const path of [
  '/o/northwind/settings',
  '/o/personal/settings',
  '/settings/profile',
  '/settings/security',
  '/admin',
  '/invite/demo',
  '/invite/expired',
  '/not-invited',
]) {
  test(`${path} is axe-clean`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expectNoAxeViolations(page);
  });
}

test('signing out leads to the login page, which is axe-clean', async ({ page }) => {
  await page.goto('/o/personal/my');
  await page.getByRole('button', { name: /Account menu/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to rooster' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await expectNoAxeViolations(page);
});
