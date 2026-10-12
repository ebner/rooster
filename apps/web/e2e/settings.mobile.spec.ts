import type { Page } from '@playwright/test';
import { signInAs, uniqueEmail } from './support/auth';
import { expect, test } from './support/test';

/**
 * Settings on phones: an index you drill into, like a native settings app. Each section has
 * "‹ Settings" back to the index in the header; nothing scrolls sideways.
 */

const shots = process.env.ROOSTER_SETTINGS_SCREENSHOTS;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      sessionStorage.setItem('e2e-init', '1');
      localStorage.setItem('rooster.locale', 'en');
    }
  });
});

const sideways = (page: Page) =>
  page.evaluate(() => {
    const main = document.querySelector('main') as HTMLElement;
    return main.scrollWidth - main.clientWidth;
  });

const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}-${test.info().project.name}.png` });
};

test('the Settings tab opens the index; a section drills in and ‹ Settings goes back', async ({
  page,
}) => {
  await signInAs(page, uniqueEmail('settings.index'));
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Settings' })
    .tap();
  await expect(page).toHaveURL(/\/settings$/);
  const index = page.getByRole('navigation', { name: 'Settings sections' });
  // Six sections, plus Help (ADR 0053) and What's new (ADR 0057).
  await expect(index.getByRole('link')).toHaveCount(8);
  await expect(index.getByRole('link', { name: /Help/ })).toHaveAttribute('href', '/help');
  await expect(index.getByRole('link', { name: /What’s new/ })).toHaveAttribute(
    'href',
    '/help/whats-new',
  );
  await expect(index.getByRole('link', { name: /Notifications/ })).toContainText(
    'In app, push, email, task reminders and the daily digest',
  );
  // Every row is a touch-size target.
  for (const box of await index
    .getByRole('link')
    .evaluateAll((links) => links.map((link) => link.getBoundingClientRect().height))) {
    expect(box).toBeGreaterThanOrEqual(44);
  }
  expect(await sideways(page)).toBe(0);
  await shot(page, 'settings-index');

  await index.getByRole('link', { name: /Notifications/ }).tap();
  await expect(page).toHaveURL(/\/settings\/notifications$/);
  const header = page.getByTestId('mobile-header');
  const title = header.getByRole('heading', { level: 1, name: 'Notifications' });
  await expect(title).toBeFocused();
  // No side menu or strip on phones: only the section.
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeHidden();
  expect(await sideways(page)).toBe(0);
  await shot(page, 'settings-section');

  await header.getByRole('link', { name: 'Back to Settings' }).tap();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(index.getByRole('link')).toHaveCount(8);
});

test('a deep link opens the section, and back leads to the index', async ({ page }) => {
  await signInAs(page, uniqueEmail('settings.deep'));
  const header = page.getByTestId('mobile-header');
  // WebKit may still be finishing the post-sign-in redirect: retry the navigation.
  await expect(async () => {
    await page.goto('/settings/security');
    await expect(header.getByRole('heading', { level: 1, name: 'Security' })).toBeVisible({
      timeout: 2_000,
    });
  }).toPass();
  await expect(page.locator('#connected-apps')).toBeAttached();
  expect(await sideways(page)).toBe(0);
  await header.getByRole('link', { name: 'Back to Settings' }).tap();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(
    page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('link', { name: /Security/ }),
  ).toBeVisible();
});
