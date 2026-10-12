import { signInAs, uniqueEmail } from './support/auth';
import { personalOrg } from './support/p3';
import { swActive, waitForPersistedLists } from './support/pwa';
import { expect, test } from './support/test';

/**
 * AC-11.6 offline: the guide's text ships in a JS chunk the service worker precaches, so it reads
 * offline without having been opened before; its screenshots are cached only once viewed.
 */
test('AC-11.6 the guide reads offline in the installed app', async ({ page, context }) => {
  await signInAs(page, uniqueEmail('pwa.help'));
  const personal = await personalOrg(page);
  await swActive(page);
  await page.reload();
  await waitForPersistedLists(page, [personal]);

  const precached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) urls.push(request.url);
    }
    return urls;
  });
  // Screenshots are not part of the install.
  expect(precached.some((url) => url.includes('/assets/guide/'))).toBe(false);

  await context.setOffline(true);
  await page.goto('/help/keyboard');
  const article = page.getByTestId('guide-article');
  await expect(article).toHaveAttribute('aria-label', 'Keyboard shortcuts');
  await expect(article.locator('kbd').first()).toBeVisible();
  // Search works offline too: it runs on the guide the app already holds.
  await page.getByRole('searchbox', { name: 'Search the guide' }).fill('palette');
  await expect(page.getByTestId('guide-search-results').getByRole('link').first()).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search the guide' }).fill('');
  await page
    .getByRole('navigation', { name: 'Previous and next page' })
    .getByRole('link', { name: /Next/ })
    .click();
  await expect(page).toHaveURL(/\/help\/(?!keyboard$)[a-z0-9-]+$/);
  await expect(page.getByTestId('guide-article')).toBeVisible();
  await context.setOffline(false);
});

test('AC-11.6 a screenshot is cached when viewed, and then shows offline', async ({
  page,
  context,
}) => {
  await signInAs(page, uniqueEmail('pwa.help.img'));
  await swActive(page);
  await page.reload();
  // The first page of the guide that has a screenshot (the guide's text may change).
  let src: string | null = null;
  for (const slug of ['getting-started', 'views-and-search', 'reminders', 'collaboration']) {
    await page.goto(`/help/${slug}`);
    await expect(page.getByTestId('guide-article')).toHaveAttribute('data-slug', slug);
    const image = page.getByTestId('guide-article').locator('img').first();
    if ((await image.count()) === 0) continue;
    await image.scrollIntoViewIfNeeded();
    await expect
      .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);
    src = await image.getAttribute('src');
    break;
  }
  test.skip(src === null, 'no guide page has a screenshot yet');
  expect(src).toMatch(/^\/assets\/guide\/[a-z0-9-]+-[0-9a-f]{10}\.png$/);
  await expect
    .poll(() =>
      page.evaluate(async (path) => {
        const cache = await caches.open('rooster-guide-images');
        return Boolean(await cache.match(path as string));
      }, src),
    )
    .toBe(true);

  await context.setOffline(true);
  const offline = await page.evaluate(async (path) => {
    const response = await fetch(path as string);
    return response.ok;
  }, src);
  expect(offline).toBe(true);
  await context.setOffline(false);
});
