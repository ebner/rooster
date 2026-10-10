import AxeBuilder from '@axe-core/playwright';
import { apiCall, signInAs, uniqueEmail } from './support/auth';
import { expect, test } from './support/test';

/**
 * Settings → Calendar feed (WP 10.3, FR-CAL): create a feed, see and copy its secret link once,
 * subscribe through `webcal://`, regenerate it, and revoke it (the URL then answers 404).
 */

const shots = process.env.ROOSTER_P10_SCREENSHOTS;
const wcag = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      sessionStorage.setItem('e2e-init', '1');
      localStorage.setItem('rooster.locale', 'en');
    }
  });
});

test('FR-CAL-1/2 a feed is created, copied once, regenerated and revoked', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInAs(page, uniqueEmail('carl.calendar'));
  const orgId = (
    (await (await apiCall(page, 'GET', '/api/v1/me')).json()) as {
      orgs: { id: string; isPersonal: boolean }[];
    }
  ).orgs.find((o) => o.isPersonal)?.id;
  await apiCall(page, 'POST', `/api/v1/orgs/${orgId}/tasks`, {
    title: 'Dentist',
    dueDate: '2026-10-20',
  });

  await page.goto('/settings/calendar');
  await expect(page.getByRole('link', { name: 'Calendar feed' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByText('No calendar feeds yet.')).toBeVisible();

  await page.getByTestId('new-feed').click();
  await page.getByTestId('create-feed').click();
  const reveal = page.getByTestId('feed-reveal');
  await expect(reveal).toContainText('Your feed for All organisations');
  await expect(reveal).toContainText('Keep this link secret');
  const url = await page.getByTestId('feed-url').inputValue();
  expect(url).toMatch(/\/ical\/rcal_[A-Za-z0-9_-]+\.ics$/);
  await expect(page.getByTestId('subscribe-feed')).toHaveAttribute(
    'href',
    url.replace(/^https?:\/\//, 'webcal://'),
  );
  await page.getByTestId('copy-feed').click();
  await expect(page.getByTestId('copy-feed')).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);

  const ics = await page.request.get(url);
  expect(ics.status()).toBe(200);
  expect(ics.headers()['content-type']).toContain('text/calendar');
  expect(await ics.text()).toContain('SUMMARY:☐ Dentist');

  const results = await new AxeBuilder({ page }).include('main').withTags(wcag).analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
  if (shots) await page.screenshot({ path: `${shots}/calendar-feed-1440.png`, fullPage: true });

  await reveal.getByRole('button', { name: 'Done' }).click();
  await expect(reveal).toHaveCount(0);
  const row = page.getByTestId('calendar-feed');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('All organisations');

  // A new link: the old URL stops working at once.
  await row.getByRole('button', { name: 'New link for All organisations' }).click();
  await row.getByTestId('confirm-feed').click();
  const fresh = await page.getByTestId('feed-url').inputValue();
  expect(fresh).not.toBe(url);
  expect((await page.request.get(url)).status()).toBe(404);
  expect((await page.request.get(fresh)).status()).toBe(200);
  await page.getByTestId('feed-reveal').getByRole('button', { name: 'Done' }).click();

  // Revoke, with an inline confirm.
  await row.getByTestId('revoke-feed').click();
  await expect(row).toContainText('Revoke the feed for All organisations?');
  await row.getByTestId('confirm-feed').click();
  await expect(page.getByTestId('calendar-feed')).toHaveCount(0);
  expect((await page.request.get(fresh)).status()).toBe(404);
});

test('phones reach the calendar feed from the settings index', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAs(page, uniqueEmail('cecilia.calendar'));
  await page.goto('/settings');
  await page
    .getByTestId('settings-index')
    .getByRole('link', { name: /Calendar feed/ })
    .click();
  await expect(page).toHaveURL(/\/settings\/calendar$/);
  await page.getByTestId('new-feed').click();
  await page.getByTestId('create-feed').click();
  await expect(page.getByTestId('feed-reveal')).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/calendar-feed-390.png`, fullPage: true });
});
