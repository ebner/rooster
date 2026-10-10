import { readFileSync } from 'node:fs';
import { apiCall, signInAs, uniqueEmail } from './support/auth';
import { expect, test } from './support/test';

/** ADR 0052 §2, AC-11.6: the user guide in the app, in the viewer's language. */

const guidePages = (
  JSON.parse(readFileSync(new URL('../../../docs/guide/pages.json', import.meta.url), 'utf8')) as {
    pages: { slug: string }[];
  }
).pages;

test('AC-11.6 the guide opens with G H and is read with the keyboard', async ({ page }) => {
  await signInAs(page, uniqueEmail('help.keys'));
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await page.keyboard.press('g');
  await page.keyboard.press('h');
  await expect(page).toHaveURL(/\/help$/);
  const index = page.getByTestId('guide-index');
  await expect(index.getByRole('link')).toHaveCount(guidePages.length);
  await expect(index.getByRole('link').first()).toHaveText(/Getting started/);

  // Enter on a page link opens it; focus lands on the article, named by its title.
  await index.getByRole('link', { name: /Keyboard shortcuts/ }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/help\/keyboard$/);
  const article = page.getByTestId('guide-article');
  await expect(article).toBeFocused();
  await expect(article).toHaveAttribute('aria-label', 'Keyboard shortcuts');
  await expect(page.getByRole('heading', { level: 1, name: 'Keyboard shortcuts' })).toBeVisible();
  // The generated page: the registry's sections and both platforms' keys.
  await expect(
    article.getByRole('columnheader', { name: 'Windows and Linux' }).first(),
  ).toBeVisible();
  await expect(article.locator('kbd', { hasText: 'Ctrl+K' }).first()).toBeVisible();

  // Next page with the keyboard.
  const steps = page.getByRole('navigation', { name: 'Previous and next page' });
  await steps.getByRole('link', { name: /Next/ }).focus();
  await page.keyboard.press('Enter');
  const next = guidePages[guidePages.findIndex((p) => p.slug === 'keyboard') + 1];
  await expect(page).toHaveURL(new RegExp(`/help/${next?.slug}$`));
  await expect(page.getByTestId('guide-article')).toBeFocused();
  await expect(
    page.getByRole('navigation', { name: 'Guide pages' }).locator('[aria-current="page"]'),
  ).toHaveAttribute('href', `/help/${next?.slug}`);
});

test('AC-11.6 the guide follows the profile language (Swedish)', async ({ page }) => {
  await signInAs(page, uniqueEmail('help.sv'));
  expect((await apiCall(page, 'PATCH', '/api/v1/me', { locale: 'sv' })).status()).toBe(200);
  await page.goto('/help');
  await expect(page.getByRole('heading', { level: 1, name: 'Hjälp' })).toBeVisible();
  await expect(page.getByTestId('guide-index').getByRole('link').first()).toHaveText(/Kom igång/);
  await page.goto('/help/keyboard');
  const article = page.getByTestId('guide-article');
  await expect(page.getByRole('heading', { level: 1, name: 'Kortkommandon' })).toBeVisible();
  await expect(article).toHaveAttribute('lang', 'sv');
  await expect(article.getByRole('columnheader', { name: 'Åtgärd' }).first()).toBeVisible();

  // A link to a Swedish heading on another page: GitHub's anchor, focused after the move.
  await page.goto('/help/reminders');
  await page
    .getByTestId('guide-article')
    .locator('a[href="/help/dates-and-repeats#återkommande-uppgifter"]')
    .first()
    .click();
  await expect(page).toHaveURL(/\/help\/dates-and-repeats#/);
  const heading = page.getByRole('heading', { level: 2, name: 'Återkommande uppgifter' });
  await expect(heading).toHaveAttribute('id', 'återkommande-uppgifter');
  await expect(heading).toBeFocused();
  await expect(heading).toBeInViewport();
});

test('AC-11.6 an unknown page says so; the cheat sheet and the user menu open the guide', async ({
  page,
}) => {
  await signInAs(page, uniqueEmail('help.links'));
  await page.goto('/help/no-such-page');
  await expect(page.getByTestId('guide-not-found')).toContainText('This page isn’t in the guide');
  await page.getByRole('link', { name: 'Go to the guide' }).click();
  await expect(page).toHaveURL(/\/help$/);

  await page.goto('/settings/profile');
  await page.getByRole('button', { name: /^Account menu for/ }).click();
  await page.getByRole('menuitem', { name: 'Help' }).click();
  await expect(page).toHaveURL(/\/help$/);

  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await page.keyboard.press('?');
  const sheet = page.getByRole('complementary', { name: 'Keyboard shortcuts' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('link', { name: 'Open the guide' }).click();
  await expect(sheet).toBeHidden();
  await expect(page).toHaveURL(/\/help$/);
});
