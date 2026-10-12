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
    // Six sections, plus the guide (ADR 0053) and What's new (ADR 0057).
    await expect(menu.getByRole('link')).toHaveCount(8);
    await expect(menu.getByRole('link', { name: /guide/i })).toHaveAttribute('href', '/help');
    await expect(menu.getByRole('link', { name: 'What’s new' })).toHaveAttribute(
      'href',
      '/help/whats-new',
    );
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

test('each page opens at its top, back restores it, and the side menu stays pinned', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  await signInAs(page, uniqueEmail('settings.scroll'));
  const scrollTop = (selector: string) =>
    page.evaluate((s) => document.querySelector(s)?.scrollTop ?? -1, selector);
  // Retried until the page is tall enough (its content may still be loading).
  const scrollMainTo = (top: number) =>
    expect
      .poll(async () => {
        await page.evaluate((y) => document.querySelector('main')?.scrollTo(0, y), top);
        return scrollTop('main');
      })
      .toBe(top);

  // Settings: the menu stays below the header while the section scrolls.
  await page.goto('/settings/notifications');
  const menu = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(menu).toBeVisible();
  const pinned = (await menu.boundingBox())?.y;
  await scrollMainTo(300);
  expect((await menu.boundingBox())?.y).toBe(pinned);

  // Another section, and then the guide, open at their top instead of at 300 px.
  await menu.getByRole('link', { name: 'Profile' }).click();
  await expect(page).toHaveURL(/\/settings\/profile$/);
  await expect.poll(() => scrollTop('main')).toBe(0);
  await scrollMainTo(300);
  await menu.getByRole('link', { name: /guide/i }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Help' })).toBeVisible();
  await expect.poll(() => scrollTop('main')).toBe(0);

  // Back returns to where Profile was left.
  await page.goBack();
  await expect(page).toHaveURL(/\/settings\/profile$/);
  await expect.poll(() => scrollTop('main')).toBe(300);
});
