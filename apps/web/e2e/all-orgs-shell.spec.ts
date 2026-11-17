import type { Page } from '@playwright/test';
import { addDays } from '@rooster/core/dates';
import { apiCall, signInAs, uniqueEmail } from './support/auth';
import { createTask, personalOrg, waitForSync } from './support/p3';
import { viewerToday } from './support/p5-views';
import { expandSection, sectionToggle } from './support/sidebar';
import { expect, test } from './support/test';

/**
 * Phase 13, WP 13.1 (ADR 0073 A): the shell around All organisations on desktop: the sidebar
 * section with summed badges (AC-13.1's badges), the start page (AC-13.2) and the default
 * organisation setting. The All screen's rows are covered by its own spec.
 */

const shots = process.env.ROOSTER_P13_SCREENSHOTS;

test.beforeEach(async ({ page }) => {
  if (shots) await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      sessionStorage.setItem('e2e-init', '1');
      localStorage.setItem('rooster.locale', 'en');
    }
  });
});

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Main' });
const region = (page: Page, name: string) => sidebar(page).getByRole('region', { name });
const allLink = (page: Page, view: RegExp) =>
  region(page, 'All organisations').getByRole('link', { name: view });
const row = (page: Page, title: string) =>
  page.getByTestId('task-row').filter({ hasText: title }).first();

interface Org {
  id: string;
  slug: string;
  name: string;
}

async function createOrg(page: Page, name: string): Promise<Org> {
  const res = await apiCall(page, 'POST', '/api/v1/orgs', { name });
  expect(res.status()).toBe(201);
  return (await res.json()) as Org;
}

/** Personal plus two orgs, each with a task due today and one two days overdue. */
async function setup(page: Page, name: string) {
  await signInAs(page, uniqueEmail(name));
  const personal = await personalOrg(page);
  const harbour = await createOrg(page, 'Harbour');
  const meadow = await createOrg(page, 'Meadow');
  const today = await viewerToday(page);
  for (const [orgId, label] of [
    [personal, 'Personal'],
    [harbour.id, 'Harbour'],
    [meadow.id, 'Meadow'],
  ] as const) {
    await createTask(page, orgId, { title: `${label} today`, dueDate: today });
    await createTask(page, orgId, { title: `${label} late`, dueDate: addDays(today, -2) });
  }
  await page.reload();
  return { personal, harbour, meadow };
}

async function prefs(page: Page) {
  const me = (await (await apiCall(page, 'GET', '/api/v1/me')).json()) as {
    prefs: { defaultOrgId: string | null; startPage: string };
  };
  return me.prefs;
}

test('AC-13.1 All organisations sums the badges of every org; completing a task in one org updates both', async ({
  page,
}) => {
  const { harbour } = await setup(page, 'all.badges');
  // Above the orgs, in this order.
  await expect(sidebar(page).getByRole('region')).toHaveText([
    /^All organisations/,
    // After the org avatar's letter.
    /^.?Personal/,
    /^.?Harbour/,
    /^.?Meadow/,
  ]);
  await expect(allLink(page, /^Today/)).toHaveText('Today6');
  await expect(allLink(page, /^Next 7 days/)).toHaveText('Next 7 days');
  await expect(allLink(page, /^Overdue/)).toHaveText('Overdue3');
  await expect(allLink(page, /^Overdue/).locator('.text-text-danger')).toHaveText('3');
  await expect(allLink(page, /^Today/)).toHaveAttribute('href', '/all/today');
  await expect(allLink(page, /^Next 7 days/)).toHaveAttribute('href', '/all/week');
  await expect(allLink(page, /^Overdue/)).toHaveAttribute('href', '/all/overdue');
  if (shots) await sidebar(page).screenshot({ path: `${shots}/1440-sidebar-all.png` });

  // Three orgs: those not in the URL start collapsed (ADR 0076). Complete Harbour's overdue
  // task in Harbour's own Today.
  await expect(sectionToggle(page, 'Harbour')).toHaveAttribute('aria-expanded', 'false');
  await expandSection(page, 'Harbour');
  await region(page, 'Harbour')
    .getByRole('link', { name: /^Today/ })
    .click();
  await expect(page).toHaveURL(new RegExp(`/o/${harbour.slug}/today$`));
  await expect(region(page, 'Harbour').getByRole('link', { name: /^Today/ })).toHaveText('Today2');
  // An org's view is not All organisations' view.
  await expect(allLink(page, /^Today/)).not.toHaveAttribute('aria-current', 'page');
  await row(page, 'Harbour late').locator('label').first().click();
  await expect(region(page, 'Harbour').getByRole('link', { name: /^Today/ })).toHaveText('Today1');
  await expect(allLink(page, /^Today/)).toHaveText('Today5');
  await expect(allLink(page, /^Overdue/)).toHaveText('Overdue2');
  await waitForSync(page);
  // Still summed after a reload (from the server's lists, not just the optimistic cache).
  await page.reload();
  await expect(allLink(page, /^Today/)).toHaveText('Today5');
  await expect(allLink(page, /^Overdue/)).toHaveText('Overdue2');
});

test('ADR 0073 A the All organisations links go to /all and show as the current page', async ({
  page,
}) => {
  await setup(page, 'all.active');
  await allLink(page, /^Next 7 days/).click();
  await expect(page).toHaveURL(/\/all\/week$/);
  await expect(allLink(page, /^Next 7 days/)).toHaveAttribute('aria-current', 'page');
  await expect(
    region(page, 'Personal').getByRole('link', { name: /^Next 7 days/ }),
  ).not.toHaveAttribute('aria-current', 'page');
  // The rail keeps the section, icon-only.
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(allLink(page, /^Next 7 days · All organisations/)).toHaveAttribute(
    'aria-current',
    'page',
  );
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
});

test('a single org has no All organisations section', async ({ page }) => {
  await signInAs(page, uniqueEmail('all.single'));
  await expect(region(page, 'Personal')).toBeVisible();
  await expect(region(page, 'All organisations')).toHaveCount(0);
  await page.goto('/settings/behaviour');
  await expect(page.getByText('Recognise dates in task names')).toBeVisible();
  await expect(page.getByText('Open rooster on')).toHaveCount(0);
  await expect(page.getByText('Default organisation')).toHaveCount(0);
});

test('AC-13.2 the start page setting opens All organisations · Today; "The last view" returns to the last list', async ({
  page,
}) => {
  const { harbour } = await setup(page, 'all.start');
  // The last list view shown in this browser.
  await expandSection(page, 'Harbour');
  await region(page, 'Harbour')
    .getByRole('link', { name: /^Next 7 days/ })
    .click();
  await expect(page).toHaveURL(new RegExp(`/o/${harbour.slug}/week$`));
  await page.goto('/settings/behaviour');
  await page.goto('/');
  await expect(page).toHaveURL(new RegExp(`/o/${harbour.slug}/week$`));

  await page.goto('/settings/behaviour');
  await expect(page.getByRole('radio', { name: 'The last view' })).toBeChecked();
  if (shots) await page.screenshot({ path: `${shots}/1440-behaviour-all.png`, fullPage: true });
  await page.getByText('All organisations · Today', { exact: true }).click();
  await expect(page.getByRole('radio', { name: 'All organisations · Today' })).toBeChecked();
  await expect.poll(async () => (await prefs(page)).startPage).toBe('all-today');
  // `/` decides from the cached profile; it is saved shortly after a change, so try again
  // until this browser's copy has it.
  await expect
    .poll(
      async () => {
        await page.goto('/');
        await page.waitForURL((url) => url.pathname !== '/');
        return new URL(page.url()).pathname;
      },
      { intervals: [500, 1000, 2000, 3000] },
    )
    .toBe('/all/today');

  await page.goto('/settings/behaviour');
  await page.getByText('The last view', { exact: true }).click();
  await expect.poll(async () => (await prefs(page)).startPage).toBe('last');
  await page.goto(`/o/${harbour.slug}/overdue`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Overdue');
  await expect
    .poll(
      async () => {
        await page.goto('/');
        await page.waitForURL((url) => url.pathname !== '/');
        return new URL(page.url()).pathname;
      },
      { intervals: [500, 1000, 2000, 3000] },
    )
    .toBe(`/o/${harbour.slug}/overdue`);
});

test('ADR 0073 A4 the default organisation is Personal until changed, and the change persists', async ({
  page,
}) => {
  const { harbour } = await setup(page, 'all.default');
  await page.goto('/settings/behaviour');
  const field = page.getByRole('button', { name: /Default organisation/ });
  await expect(field).toContainText('Personal');
  expect((await prefs(page)).defaultOrgId).toBeNull();
  await field.click();
  await page.getByRole('option', { name: 'Harbour' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved' }).first()).toBeVisible();
  await expect.poll(async () => (await prefs(page)).defaultOrgId).toBe(harbour.id);
  await page.reload();
  await expect(page.getByRole('button', { name: /Default organisation/ })).toContainText('Harbour');
  // Back to Personal: stored as null, the default.
  await page.getByRole('button', { name: /Default organisation/ }).click();
  await page.getByRole('option', { name: 'Personal' }).click();
  await expect.poll(async () => (await prefs(page)).defaultOrgId).toBeNull();
});
