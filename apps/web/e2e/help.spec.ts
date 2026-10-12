import { readFileSync } from 'node:fs';
import { expectAxeClean } from './support/a11y';
import { apiCall, signInAs, uniqueEmail } from './support/auth';
import { expect, reload, test } from './support/test';

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
  // The header names the guide; the page list beside the article shows which page this is.
  await expect(page.getByRole('heading', { level: 1, name: 'Help' })).toBeVisible();
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
  await expect(page.getByRole('heading', { level: 1, name: 'Hjälp' })).toBeVisible();
  await expect(article).toHaveAttribute('aria-label', 'Kortkommandon');
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

test("What's new: after an update a toast opens the version's section, once; Settings links to it", async ({
  page,
}) => {
  const { version } = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  await signInAs(page, uniqueEmail('help.whatsnew'));
  const me = (await (await apiCall(page, 'GET', '/api/v1/me')).json()) as { id: string };
  const seenKey = `rooster.user.${me.id}.whatsNew.seen`;
  const updated = page.getByRole('status').filter({ hasText: 'rooster was updated' });
  // A first visit only records the version.
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), seenKey)).toBe(version);
  await expect(updated).toHaveCount(0);

  // An older version was seen here: this load is an update.
  await page.evaluate((key) => localStorage.setItem(key, '1.0.0'), seenKey);
  await reload(page);
  await expect(updated).toHaveText(new RegExp(`rooster was updated to ${version}\\.`));
  await updated.getByRole('button', { name: 'What’s new' }).click();
  await expect(page).toHaveURL(new RegExp(`/help/whats-new#${version.replaceAll('.', '')}$`));
  await expect(page.getByTestId('guide-article')).toHaveAttribute('aria-label', 'What’s new');
  await expect(
    page.getByRole('heading', { level: 2, name: version, exact: true }),
  ).toBeInViewport();

  // Once: the next load says nothing.
  await page.goto('/settings/profile');
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await page.waitForTimeout(1_000);
  await expect(updated).toHaveCount(0);
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'What’s new' })
    .click();
  await expect(page).toHaveURL(/\/help\/whats-new$/);
  await expect(page.getByTestId('guide-article')).toHaveAttribute('aria-label', 'What’s new');
});

test('the guide is searched from its page list, and Back returns to the results', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInAs(page, uniqueEmail('help.search'));
  await page.goto('/help/my-tasks');
  await expect(page.getByTestId('guide-article')).toBeVisible();
  const field = page.getByRole('searchbox', { name: 'Search the guide' });
  await field.fill('tui');
  await expect(page).toHaveURL(/\/help\/my-tasks\?q=tui$/);
  const results = page.getByTestId('guide-search-results');
  await expect(results.getByRole('status')).toHaveText(/match/);
  await expect(page.getByTestId('guide-article')).toBeHidden();
  const first = results.getByRole('link').first();
  await expect(first).toContainText('The terminal app (TUI)');
  await expect(first.locator('mark').first()).toHaveText(/tui/i);
  await expectAxeClean(page, 'guide search results');

  // ↓ then Enter opens the result at its heading.
  await field.press('ArrowDown');
  await expect(first).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/help\/cli-tui-mcp#the-terminal-app-tui$/);
  await expect(page.getByRole('heading', { name: 'The terminal app (TUI)' })).toBeFocused();
  await page.goBack();
  await expect(page).toHaveURL(/\?q=tui$/);
  await expect(page.getByTestId('guide-search-results')).toBeVisible();
  await expect(field).toHaveValue('tui');

  // Esc clears the search and brings the page back, with focus still in the field.
  await field.focus();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/help\/my-tasks$/);
  await expect(page.getByTestId('guide-article')).toBeVisible();
  await expect(field).toBeFocused();

  // The index searches too (on phones it is the only place); nothing found says so.
  await page.goto('/help?q=repeat');
  await expect(page.getByTestId('guide-search-results').getByRole('link').first()).toBeVisible();
  await field.fill('qqqzzz');
  await expect(page.getByTestId('guide-search-results').getByRole('status')).toHaveText(
    'Nothing in the guide matches “qqqzzz”.',
  );
  await expect(page.getByRole('navigation', { name: 'Guide pages' })).toBeHidden();
  // Enter in the field opens the first result.
  await field.fill('reminder');
  await field.press('Enter');
  await expect(page).toHaveURL(/\/help\/reminders/);
});
