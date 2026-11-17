import type { Page } from '@playwright/test';
import { addDays } from '@rooster/core/dates';
import type { Task } from '@rooster/core/schemas';
import { expectAxeClean } from './support/a11y';
import { apiCall, signInAs, uniqueEmail } from './support/auth';
import { createTask, groupId, myList, personalOrg, waitForSync } from './support/p3';
import { viewerToday } from './support/p5-views';
import { expect, reload, test } from './support/test';

/** Phase 13, WP 13.1 (ADR 0073 A): All organisations on desktop against the real server. */

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

interface Org {
  id: string;
  slug: string;
}

async function createOrg(page: Page, name: string): Promise<Org> {
  const res = await apiCall(page, 'POST', '/api/v1/orgs', { name });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as Org;
}

/**
 * A user in Personal and two shared orgs (Kestrel Lane, Rowing club), with overdue and today
 * tasks in each, and some that All · Today leaves out.
 */
async function setupOrgs(page: Page, name: string) {
  await signInAs(page, uniqueEmail(name));
  const personal = await personalOrg(page);
  const kestrel = await createOrg(page, 'Kestrel Lane');
  const rowing = await createOrg(page, 'Rowing club');
  const today = await viewerToday(page);
  const seed: [string, string, string | null][] = [
    [personal, 'Pay the invoice', addDays(today, -2)],
    [personal, 'Renew the passport', today],
    [personal, 'Someday idea', null],
    [kestrel.id, 'Call the caterer', addDays(today, -1)],
    [kestrel.id, 'Send the slides', today],
    [kestrel.id, 'Plan the offsite', addDays(today, 3)],
    [rowing.id, 'Fix the oar', today],
  ];
  const tasks: Record<string, Task> = {};
  for (const [org, title, dueDate] of seed) {
    tasks[title] = await createTask(page, org, { title, ...(dueDate ? { dueDate } : {}) });
  }
  return { personal, kestrel, rowing, today, tasks };
}

const row = (page: Page, title: string) =>
  page.getByTestId('task-row').filter({ hasText: title }).first();
const orgChip = (page: Page, title: string) =>
  row(page, title).getByTestId('org-chip').locator('[aria-hidden]').last();
const sectionNames = (page: Page) => page.getByTestId('section-header').locator('h2');

async function taskIn(page: Page, orgId: string, id: string) {
  return (await myList(page, orgId)).tasks.find((t) => t.id === id);
}

test('AC-13.1 All · Today mixes every org’s overdue and today tasks with org chips; completing one from Kestrel updates Kestrel’s Today; it works offline and syncs later', async ({
  page,
  context,
}) => {
  const { kestrel, rowing, tasks } = await setupOrgs(page, 'all.acone');
  await page.goto('/all/today');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Today');
  await expect(page.getByText('All organisations').first()).toBeVisible();
  await expect(sectionNames(page)).toHaveText([
    'Overdue',
    /^[A-Z][a-z]+day, [A-Z][a-z]{2} \d{1,2}$/,
  ]);
  // By due date, then the sidebar's org order (Personal first).
  await expect(page.getByTestId('task-row').locator('[data-focus-target]')).toHaveText([
    'Pay the invoice',
    'Call the caterer',
    'Renew the passport',
    'Send the slides',
    'Fix the oar',
  ]);
  await expect(orgChip(page, 'Pay the invoice')).toHaveText('Personal');
  await expect(orgChip(page, 'Call the caterer')).toHaveText('Kestrel Lane');
  await expect(orgChip(page, 'Fix the oar')).toHaveText('Rowing club');
  await expect(row(page, 'Send the slides')).toHaveAttribute('aria-label', /in Kestrel Lane/);
  await expect(page.locator('[data-drag-handle]')).toHaveCount(0);
  await expectAxeClean(page, 'all-today');
  if (shots) await page.screenshot({ path: `${shots}/1440-all-today.png` });

  // Completing Kestrel's task here completes it in Kestrel.
  await row(page, 'Send the slides').locator('label').first().click();
  await expect(row(page, 'Send the slides')).toHaveCount(0, { timeout: 5_000 });
  await waitForSync(page);
  expect(
    (await taskIn(page, kestrel.id, tasks['Send the slides']?.id ?? ''))?.completedAt,
  ).not.toBeNull();
  await page.goto(`/o/${kestrel.slug}/today`);
  await expect(row(page, 'Call the caterer')).toBeVisible();
  await expect(row(page, 'Send the slides')).toHaveCount(0);

  // Offline: from the cached lists; the completion syncs once back online. (In-app navigation
  // only: the dev server can't load a route's code while offline.)
  await page
    .getByRole('region', { name: 'All organisations' })
    .getByRole('link', { name: /^Today/ })
    .click();
  await expect(page).toHaveURL(/\/all\/today$/);
  await expect(row(page, 'Fix the oar')).toBeVisible();
  await context.setOffline(true);
  await row(page, 'Fix the oar').locator('label').first().click();
  await expect(row(page, 'Fix the oar')).toHaveCount(0, { timeout: 5_000 });
  await expect(page.getByTestId('sync-state')).not.toHaveAttribute('data-pending', '0');
  // Rowing club's own Today, from its cache.
  await page
    .getByRole('region', { name: 'Rowing club' })
    .getByRole('link', { name: /^Today/ })
    .click();
  await expect(page).toHaveURL(new RegExp(`/o/${rowing.slug}/today$`));
  await expect(row(page, 'Fix the oar')).toHaveCount(0);
  await context.setOffline(false);
  await waitForSync(page);
  expect(
    (await taskIn(page, rowing.id, tasks['Fix the oar']?.id ?? ''))?.completedAt,
  ).not.toBeNull();
});

test('AC-13.2 "Book the venue ^Kes" in All · Today goes to Kestrel Lane’s Inbox, due today; without the token to the default org; the chip follows the default', async ({
  page,
}) => {
  const { personal, kestrel, today } = await setupOrgs(page, 'all.actwo');
  await page.goto('/all/today');
  await expect(row(page, 'Fix the oar')).toBeVisible();

  await page.getByRole('button', { name: 'Add task' }).click();
  const input = page.locator('[data-list-input]');
  await expect(page.getByTestId('draft-org-chip')).toContainText('Personal');
  await input.pressSequentially('Book the venue ^Kes');
  const suggest = page.getByTestId('org-suggest');
  await expect(suggest.getByRole('option')).toHaveCount(1);
  await expect(suggest.getByRole('option', { name: 'Kestrel Lane' })).toBeVisible();
  await expect(page.getByTestId('draft-org-chip')).toContainText('Kestrel Lane');
  await expect(input.locator('..').locator('mark')).toHaveText('^Kes');
  if (shots) await page.screenshot({ path: `${shots}/1440-all-draft-suggest.png` });
  // The token as typed names Kestrel Lane already: Escape closes the list, Enter creates.
  await input.press('Escape');
  await expect(suggest).toHaveCount(0);
  await input.press('Enter');
  await expect(row(page, 'Book the venue')).toBeVisible();
  await expect(orgChip(page, 'Book the venue')).toHaveText('Kestrel Lane');
  // Without the token: the default org (Personal).
  await input.pressSequentially('Water the plants');
  await input.press('Enter');
  await page.keyboard.press('Escape');
  await expect(orgChip(page, 'Water the plants')).toHaveText('Personal');
  await waitForSync(page);
  const venue = (await myList(page, kestrel.id)).tasks.find((t) => t.title === 'Book the venue');
  expect(venue?.dueDate).toBe(today);
  expect(venue?.placement?.groupId).toBe(await groupId(page, kestrel.id, 'Inbox'));
  const plants = (await myList(page, personal)).tasks.find((t) => t.title === 'Water the plants');
  expect(plants?.dueDate).toBe(today);

  // Changing the default organisation changes the new row's chip.
  const patched = await apiCall(page, 'PATCH', '/api/v1/me', {
    prefs: { defaultOrgId: kestrel.id },
  });
  expect(patched.status(), await patched.text()).toBe(200);
  await reload(page);
  await expect(row(page, 'Fix the oar')).toBeVisible();
  await page.getByRole('button', { name: 'Add task' }).click();
  await expect(page.getByTestId('draft-org-chip')).toContainText('Kestrel Lane');
  if (shots) await page.screenshot({ path: `${shots}/1440-all-draft-default.png` });
  await page.keyboard.type('Order the flowers');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(orgChip(page, 'Order the flowers')).toHaveText('Kestrel Lane');
});

test('Next 7 days and Overdue; the keyboard works as in a smart view; the pane opens over the view and closes back to it', async ({
  page,
}) => {
  const { kestrel, tasks } = await setupOrgs(page, 'all.keys');
  await page.goto('/all/week');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Next 7 days');
  await expect(sectionNames(page)).toHaveCount(7);
  await expect(orgChip(page, 'Plan the offsite')).toHaveText('Kestrel Lane');
  await page.goto('/all/overdue');
  await expect(page.getByTestId('task-row')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Add task' })).toHaveCount(0);

  // The palette's entries are the keyboard path to All organisations.
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('palette-input')).toBeFocused();
  await page.keyboard.type('All organisations: Today');
  await expect(
    page.getByTestId('palette-action').filter({ hasText: 'All organisations: Today' }),
  ).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/all\/today$/);
  await expect(row(page, 'Pay the invoice')).toBeVisible();

  // j/k, then D re-dates the row in its own org; Enter opens the pane.
  await row(page, 'Call the caterer').locator('[data-focus-target]').focus();
  await page.keyboard.press('j');
  await expect(row(page, 'Renew the passport')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('k');
  await expect(row(page, 'Call the caterer')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('o');
  await expect(page).toHaveURL(new RegExp(`/all/t/${tasks['Call the caterer']?.id}$`));
  await expect(page.getByTestId('detail-pane')).toContainText('Call the caterer');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/all\/today$/);

  // Ctrl+Enter completes, Ctrl+Z brings it back, in Kestrel.
  await row(page, 'Call the caterer').locator('[data-focus-target]').focus();
  await page.keyboard.press('Control+Enter');
  await waitForSync(page);
  expect(
    (await taskIn(page, kestrel.id, tasks['Call the caterer']?.id ?? ''))?.completedAt,
  ).not.toBeNull();
  await page.keyboard.press('Control+z');
  await waitForSync(page);
  expect((await taskIn(page, kestrel.id, tasks['Call the caterer']?.id ?? ''))?.completedAt).toBe(
    null,
  );
});
