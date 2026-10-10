import type { Page } from '@playwright/test';
import type { Task } from '@rooster/core/schemas';
import { apiCall, signInAs, uniqueEmail } from './support/auth';
import { createTask, mod, myList, personalOrg, waitForSync } from './support/p3';
import { sharedOrg } from './support/p6-people';
import { expect, test } from './support/test';

/**
 * Phase 10, WP 10.1 and 10.4 in the web app: completing a recurring task (AC-10.1), the
 * recurring delete question (FR-REC-4), the repeat and reminder sections of the date picker,
 * the `!1h` title token and the row's bell, which only its owner sees (AC-10.4).
 */

const shots = process.env.ROOSTER_P10_SCREENSHOTS;

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      sessionStorage.setItem('e2e-init', '1');
      localStorage.setItem('rooster.locale', 'en');
    }
  });
});

const row = (page: Page, title: string) =>
  page
    .getByTestId('task-row')
    .filter({ has: page.locator('[data-focus-target]').getByText(title, { exact: true }) });

/** Today in the browser's zone, as the server sees the user's (the e2e user keeps the default). */
async function todayOf(page: Page): Promise<string> {
  const me = (await (await apiCall(page, 'GET', '/api/v1/me')).json()) as {
    timezone: string;
  };
  return page.evaluate(
    (zone) => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date()),
    me.timezone,
  );
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function signInPersonal(page: Page, name: string) {
  await signInAs(page, uniqueEmail(name));
  const orgId = await personalOrg(page);
  const home = page.url();
  return { orgId, home };
}

test('AC-10.1 completing a weekly task shows the next instance directly below', async ({
  page,
}) => {
  const { orgId, home } = await signInPersonal(page, 'ac.tenone');
  const today = await todayOf(page);
  // API creates go to the top of the Inbox: this one ends up second.
  await createTask(page, orgId, { title: 'Something else' });
  const weekly = await createTask(page, orgId, {
    title: 'Water the plants',
    dueDate: today,
    recurrence: 'FREQ=WEEKLY',
  });
  await page.goto(home);
  await expect(row(page, 'Water the plants')).toHaveCount(1);
  if (shots) await page.screenshot({ path: `${shots}/1440-row-repeat-icon.png` });
  await expect(row(page, 'Water the plants').getByTestId('repeat-indicator')).toHaveAttribute(
    'title',
    /^Repeats: Weekly on /,
  );

  await row(page, 'Water the plants').locator('[data-focus-target]').focus();
  await page.keyboard.press(`${mod}+Enter`);
  // The held original and, directly below it, the next instance.
  await expect(row(page, 'Water the plants')).toHaveCount(2);
  const titles = page.getByTestId('task-row').locator('[data-focus-target]');
  await expect(titles.nth(0)).toHaveText('Water the plants');
  await expect(titles.nth(1)).toHaveText('Water the plants');
  await expect(titles.nth(2)).toHaveText('Something else');
  await waitForSync(page);
  const tasks = (await myList(page, orgId)).tasks.filter((t) => t.title === 'Water the plants');
  const next = tasks.find((t) => t.id !== weekly.id) as Task;
  expect(next.completedAt).toBeNull();
  expect(next.dueDate).toBe(addDays(today, 7));
  expect(next.recurrence).toMatch(/^FREQ=WEEKLY/);
  // After the hold only the next one remains.
  await expect(row(page, 'Water the plants')).toHaveCount(1);
});

test('FR-REC-4 deleting a repeating task asks; "this task" keeps the series', async ({ page }) => {
  const { orgId, home } = await signInPersonal(page, 'rec.delete');
  const today = await todayOf(page);
  const daily = await createTask(page, orgId, {
    title: 'Morning standup',
    dueDate: today,
    recurrence: 'FREQ=DAILY',
  });
  await page.goto(home);
  await row(page, 'Morning standup').locator('[data-focus-target]').focus();
  await page.keyboard.press('Delete');
  const prompt = page.getByTestId('recurring-delete');
  await expect(prompt).toBeVisible();
  await expect(prompt.getByTestId('recurring-delete-this')).toBeFocused();
  if (shots) await page.screenshot({ path: `${shots}/1440-recurring-delete.png` });
  await page.keyboard.press('Enter');
  await expect(page.getByText('Task deleted · the series continues')).toBeVisible();
  await waitForSync(page);
  const tasks = (await myList(page, orgId)).tasks.filter((t) => t.title === 'Morning standup');
  expect(tasks.map((t) => t.id)).not.toContain(daily.id);
  expect(tasks).toHaveLength(1);
  expect(tasks[0]?.dueDate).toBe(addDays(today, 1));

  // "This and following" ends the series.
  await row(page, 'Morning standup').locator('[data-focus-target]').focus();
  await page.keyboard.press('Delete');
  await page.getByTestId('recurring-delete-following').click();
  await expect(row(page, 'Morning standup')).toHaveCount(0);
  await waitForSync(page);
  expect((await myList(page, orgId)).tasks.some((t) => t.title === 'Morning standup')).toBe(false);
});

test('the picker: Repeat presets and Alt+R reminders; the pane lists them', async ({ page }) => {
  const { orgId, home } = await signInPersonal(page, 'rec.picker');
  const today = await todayOf(page);
  await createTask(page, orgId, { title: 'Pay the rent', dueDate: addDays(today, 3) });
  await page.goto(home);
  await row(page, 'Pay the rent').locator('[data-focus-target]').focus();
  await page.keyboard.press('d');
  const dialog = page.getByRole('dialog', { name: 'Due date' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Repeat' }).click();
  await dialog.getByText(/^Monthly on the /).click();
  await page.keyboard.press('Alt+r');
  const reminders = dialog.getByTestId('reminder-section');
  await expect(reminders).toBeVisible();
  await reminders.getByRole('button', { name: '1 day before' }).click();
  await expect(reminders.getByTestId('reminder-chip')).toContainText('1 day before');
  if (shots) await page.screenshot({ path: `${shots}/1440-picker-repeat-reminders.png` });
  // Enter in the date input commits the repeat with the date.
  await dialog.getByRole('textbox', { name: 'Type a date' }).press('Enter');
  await expect(dialog).toHaveCount(0);
  const meta = row(page, 'Pay the rent');
  await expect(meta.getByTestId('repeat-indicator')).toHaveAttribute('title', /Monthly on the/);
  await expect(meta.getByTestId('reminder-indicator')).toHaveAttribute('title', /^Reminder: /);
  if (shots) await page.screenshot({ path: `${shots}/1440-row-icons.png` });

  await meta.locator('[data-focus-target]').focus();
  await page.keyboard.press('o');
  const pane = page.getByTestId('detail-pane');
  await expect(pane.getByTestId('pane-repeat')).toContainText('Monthly on the');
  await expect(pane.getByTestId('pane-reminders').getByTestId('reminder-chip')).toContainText(
    '1 day before',
  );
  if (shots) await pane.screenshot({ path: `${shots}/1440-pane-repeat-reminders.png` });
});

test('AC-10.4 the `!1h` token sets a reminder; the bell is only its owner’s', async ({
  page,
  browser,
}) => {
  const { a, b, slug } = await sharedOrg(page, browser, 'ac.tenfour');
  await a.goto(`/o/${slug}/my`);
  await a.getByRole('button', { name: 'Add task' }).first().click();
  await a.keyboard.type('Call the bank tomorrow at 14 !1h');
  await expect(a.locator('mark')).toHaveCount(2);
  if (shots) await a.screenshot({ path: `${shots}/1440-title-tokens.png` });
  await a.keyboard.press('Enter');
  await a.keyboard.press('Escape');
  const bell = row(a, 'Call the bank').getByTestId('reminder-indicator');
  await expect(bell).toHaveAttribute('title', /^Reminder: Tomorrow 13(:00)?/);
  await waitForSync(a);

  // B sees the task in Everyone's tasks, without a bell.
  await b.goto(`/o/${slug}/everyone`);
  await expect(row(b, 'Call the bank')).toBeVisible();
  await expect(row(b, 'Call the bank').getByTestId('reminder-indicator')).toHaveCount(0);
});

test('390 px: the date sheet has Repeat and Reminders; the pane sheet lists them', async ({
  page,
}) => {
  test.skip(!shots, 'screenshots only');
  const { orgId, home } = await signInPersonal(page, 'rec.phone');
  const today = await todayOf(page);
  await createTask(page, orgId, {
    title: 'Gym',
    dueDate: addDays(today, 1),
    dueTime: '07:30',
    dueTz: 'UTC',
    recurrence: 'FREQ=WEEKLY;BYDAY=MO,WE,FR',
    reminders: [{ offsetMinutes: 15 }],
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(home);
  await expect(row(page, 'Gym')).toBeVisible();
  await page.screenshot({ path: `${shots}/390-row-icons.png` });
  await row(page, 'Gym')
    .getByRole('button', { name: /^Due date/ })
    .click();
  await expect(page.getByTestId('quick-date-sheet')).toBeVisible();
  await page.screenshot({ path: `${shots}/390-date-sheet.png` });
  await page.getByTestId('quick-date-sheet').getByRole('button', { name: 'Reminders' }).click();
  await expect(
    page.getByTestId('reminder-section').getByRole('button', { name: 'At due time' }),
  ).toBeFocused();
  await expect(page.getByTestId('reminder-section')).toBeInViewport();
  await page.screenshot({ path: `${shots}/390-date-sheet-reminders.png` });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  // The pane sheet: Reminders and Repeat rows.
  await row(page, 'Gym').locator('[data-focus-target]').click();
  await expect(page.getByTestId('sheet-repeat')).toContainText('Weekly on');
  await page.screenshot({ path: `${shots}/390-pane-sheet.png` });
});
