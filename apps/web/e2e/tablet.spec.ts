import AxeBuilder from '@axe-core/playwright';
import { signInAs, uniqueEmail } from './support/auth';
import { clickRowBody, createTask, groupId, personalOrg } from './support/p3';
import { expect, test } from './support/test';

/** WP 4.7 (02 §2): at 768–1199 px the sidebar is a rail that expands over the content, and
 * the pane is a 480 px overlay with a scrim. */
const wcag = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const shots = process.env.ROOSTER_P4_SCREENSHOTS;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      sessionStorage.setItem('e2e-init', '1');
      localStorage.setItem('rooster.locale', 'en');
      localStorage.removeItem('rooster.sidebar.collapsed');
    }
  });
});

test('tablet 1024 px: the rail expands over the content and the pane overlays', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await signInAs(page, uniqueEmail('tablet.user'));
  const orgId = await personalOrg(page);
  await createTask(page, orgId, {
    title: 'Plan the offsite',
    groupId: await groupId(page, orgId, 'Today'),
  });
  await page.reload();
  const main = page.locator('main');
  await expect(page.getByText('Plan the offsite')).toBeVisible();
  const before = await main.boundingBox();
  // The rail, not the full sidebar.
  const nav = page.getByRole('navigation', { name: 'Main' });
  expect(Math.round((await nav.first().boundingBox())?.width ?? 0)).toBe(56);

  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  const expanded = page.getByTestId('rail-expanded');
  await expect(expanded).toBeVisible();
  expect(Math.round((await expanded.boundingBox())?.width ?? 0)).toBe(248);
  // Over the content: main keeps its place and width.
  expect(await main.boundingBox()).toEqual(before);
  await expect(page.getByTestId('rail-scrim')).toBeVisible();
  await page.waitForTimeout(300);
  if (shots) await page.screenshot({ path: `${shots}/1024-rail.png` });
  await page.keyboard.press('Escape');
  await expect(expanded).toHaveCount(0);
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await page.getByTestId('rail-scrim').click({ position: { x: 900, y: 400 } });
  await expect(expanded).toHaveCount(0);

  await clickRowBody(page, 'Plan the offsite');
  const pane = page.locator('[data-pane-root]');
  await expect(page.getByTestId('detail-pane')).toBeVisible();
  await expect(page.locator('[data-pane-mode="overlay"]')).toBeVisible();
  expect(Math.round((await pane.boundingBox())?.width ?? 0)).toBe(480);
  await expect(page.getByTestId('pane-scrim')).toBeVisible();
  await page.waitForTimeout(300);
  if (shots) await page.screenshot({ path: `${shots}/1024-pane.png` });
  const results = await new AxeBuilder({ page }).withTags(wcag).analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
  await page.getByTestId('pane-scrim').click({ position: { x: 100, y: 400 } });
  await expect(page.getByTestId('detail-pane')).toHaveCount(0);
});
