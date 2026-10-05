import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

const sections = [
  ['foundations', 'Foundations', 'Grunder'],
  ['button', 'Button', 'Knapp'],
  ['iconButton', 'Icon button', 'Ikonknapp'],
  ['input', 'Input', 'Textfält'],
  ['checkbox', 'Task checkbox', 'Uppgiftsbock'],
  ['chip', 'Chip and tag', 'Etikett och tagg'],
  ['kbd', 'Keyboard hint', 'Kortkommando'],
  ['tooltip', 'Tooltip', 'Verktygstips'],
  ['popover', 'Popover', 'Popover'],
  ['menu', 'Menu', 'Meny'],
  ['toast', 'Toast', 'Notis'],
  ['avatar', 'Avatar', 'Avatar'],
  ['skeleton', 'Skeleton', 'Platshållare'],
  ['syncPill', 'Sync pill', 'Synkindikator'],
  ['sidebar', 'Sidebar', 'Sidofält'],
  ['pickers', 'Pickers', 'Väljare'],
  ['formControls', 'Form controls', 'Formulärkontroller'],
  ['auth', 'Sign-in screens', 'Inloggningssidor'],
  ['orgSettings', 'Organisation settings', 'Organisationsinställningar'],
  ['userSettings', 'User settings', 'Användarinställningar'],
  ['admin', 'Admin', 'Administration'],
  ['list', 'My tasks list', 'Listan Mina uppgifter'],
  ['dates', 'Due dates', 'Förfallodatum'],
] as const;

async function openKitchenSink(page: Page) {
  await page.goto('/_dev/ui');
  // The embedded sign-in screens bring their own h1s, so match the page title by name.
  await expect(page.getByRole('heading', { level: 1, name: 'Kitchen sink' })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      sessionStorage.setItem('e2e-init', '1');
      localStorage.setItem('rooster.locale', 'en');
    }
  });
});

test('AC-0.4 /_dev/ui renders every Coop v0 component section', async ({ page }) => {
  await openKitchenSink(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Kitchen sink' })).toBeVisible();
  for (const [id, title] of sections) {
    const section = page.getByTestId(`section-${id}`);
    await expect(section.getByRole('heading', { level: 2, name: title }).first()).toBeVisible();
  }
  await expect(
    page.getByTestId('section-button').getByRole('button', { name: 'Add task' }),
  ).toHaveCount(7);
  await expect(page.getByRole('checkbox').first()).toBeVisible();
  await expect(page.getByRole('menu', { name: 'Task actions' })).toBeVisible();
  await expect(page.getByRole('tooltip').first()).toBeVisible();
});

test('AC-0.4 kitchen sink has no axe violations (WCAG 2.2 AA)', async ({ page }) => {
  await openKitchenSink(page);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' | ')}`),
  ).toEqual([]);
});

test('AC-0.4 interactive overlays and toasts stay axe-clean', async ({ page }) => {
  await openKitchenSink(page);
  await page.getByRole('button', { name: 'Show toast with undo' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Task deleted' })).toBeVisible();
  await page.getByRole('button', { name: 'Show error toast' }).click();
  await expect(
    page.getByRole('region', { name: 'Notifications' }).getByRole('alert'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Show details' }).click();
  await expect(page.getByRole('dialog', { name: 'Due date' })).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
});

test('toasts stack at most three, newest at the bottom, with a working action', async ({
  page,
}) => {
  await openKitchenSink(page);
  const region = page.getByRole('region', { name: 'Notifications' });
  for (let i = 0; i < 4; i += 1)
    await page.getByRole('button', { name: 'Show toast', exact: true }).click();
  await page.getByRole('button', { name: 'Show toast with undo' }).click();
  await expect(region.getByRole('status')).toHaveCount(3);
  await expect(region.getByRole('status').last()).toContainText('Task deleted');
  await region.getByRole('button', { name: 'Undo' }).click();
  await expect(region.getByRole('status').last()).toContainText('Deletion undone');
});

test('AC-0.5 switching to Svenska translates the kitchen sink and persists across reload', async ({
  page,
}) => {
  await openKitchenSink(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  await page.getByRole('radio', { name: 'Svenska' }).first().click();

  await expect(page.locator('html')).toHaveAttribute('lang', 'sv');
  await expect(page.getByRole('heading', { level: 1, name: 'Komponentkatalog' })).toBeVisible();
  for (const [id, , sv] of sections) {
    await expect(
      page.getByTestId(`section-${id}`).getByRole('heading', { level: 2 }).first(),
    ).toHaveText(sv);
  }
  await expect(
    page.getByTestId('section-button').getByRole('button', { name: 'Lägg till uppgift' }).first(),
  ).toBeVisible();
  await expect(page.getByText('Offline · 3 väntande')).toBeVisible();
  await expect(page.getByText('Kitchen sink')).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Komponentkatalog' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'sv');
  await expect(page.getByRole('radio', { name: 'Svenska' }).first()).toBeChecked();
});

test('WP 1.4 / sends signed-out visitors to the login page', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login\?redirect=%2Fo%2Fpersonal%2Fmy$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to rooster' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'rooster' })).toBeVisible();
});
