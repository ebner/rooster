import { signInAs, uniqueEmail } from './support/auth';
import { expect, test } from './support/test';

/** Desktop and tablet keep the side menu; `/settings` opens the first section (no index). */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      sessionStorage.setItem('e2e-init', '1');
      localStorage.setItem('rooster.locale', 'en');
    }
  });
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 900, height: 1100 },
]) {
  test(`/settings at ${viewport.width} px redirects to Profile beside the side menu`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await signInAs(page, uniqueEmail('settings.desk'));
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/settings\/profile$/);
    const menu = page.getByRole('navigation', { name: 'Settings sections' });
    await expect(menu.getByRole('link')).toHaveCount(5);
    await expect(menu.getByRole('link', { name: 'Profile' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByTestId('settings-index')).toHaveCount(0);
    await expect(page.getByTestId('header-back')).toHaveCount(0);
    await menu.getByRole('link', { name: 'Security' }).click();
    await expect(page).toHaveURL(/\/settings\/security$/);
    await expect(menu.getByRole('link', { name: 'Security' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
}
