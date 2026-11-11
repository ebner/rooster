import type { Page, Request } from '@playwright/test';
import { addDays, todayIn } from '@rooster/core/dates';
import { expectAxeClean } from './support/a11y';
import { apiCall, signInAs, uniqueEmail } from './support/auth';
import { createTask, groupId, mod, myList, personalOrg, waitForSync } from './support/p3';
import { expect, test } from './support/test';

/**
 * ADR 0068 (FR-REC-5) on desktop: a repeating task whose day hasn't come waits in the folded
 * Upcoming section at the end of My tasks, not in its group. It can't be dragged or moved;
 * a date of today brings it back to its group, at its own place.
 */

const shots = process.env.ROOSTER_UPCOMING_SCREENSHOTS;

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

/** The titles of one group's rows, in order (the group header is followed by its rows). */
async function groupTitles(page: Page, group: string): Promise<string[]> {
  return page.evaluate((name) => {
    const rows = [...document.querySelectorAll<HTMLElement>('[data-list-root] [role="row"]')];
    const start = rows.findIndex(
      (r) => r.dataset.testid === 'group-header' && r.querySelector('h2')?.textContent === name,
    );
    const out: string[] = [];
    for (const r of rows.slice(start + 1)) {
      if (r.dataset.testid !== 'task-row') break;
      out.push(r.querySelector('[data-focus-target]')?.textContent ?? '');
    }
    return out;
  }, group);
}

function moveRequests(page: Page): Request[] {
  const seen: Request[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET' && /\/tasks\/[^/]+\/move$|\/bulk$/.test(path))
      seen.push(request);
  });
  return seen;
}

/** Today: Alpha, a weekly "Water the plants" due today, Beta. */
async function setup(page: Page, name: string) {
  await signInAs(page, uniqueEmail(name));
  const orgId = await personalOrg(page);
  const today = await groupId(page, orgId, 'Today');
  const me = (await (await apiCall(page, 'GET', '/api/v1/me')).json()) as { timezone: string };
  const date = todayIn(me.timezone, Date.now());
  const alpha = await createTask(page, orgId, { title: 'Alpha', groupId: today });
  const weekly = await createTask(page, orgId, {
    title: 'Water the plants',
    groupId: today,
    afterId: alpha.id,
    beforeId: null,
    dueDate: date,
    recurrence: 'FREQ=WEEKLY',
  });
  await createTask(page, orgId, {
    title: 'Beta',
    groupId: today,
    afterId: weekly.id,
    beforeId: null,
  });
  await page.reload();
  await expect(row(page, 'Beta')).toBeVisible({ timeout: 15_000 });
  return { orgId, today, date, weekly };
}

test('ADR 0068 a completed weekly task’s next instance waits in Recurring until its day', async ({
  page,
}) => {
  const { orgId, today, date, weekly } = await setup(page, 'upcoming.desk');
  const moves = moveRequests(page);
  expect(await groupTitles(page, 'Today')).toEqual(['Alpha', 'Water the plants', 'Beta']);
  await expect(page.getByTestId('upcoming-header')).toHaveCount(0);

  await row(page, 'Water the plants').locator('label').first().click();
  const header = page.getByTestId('upcoming-header');
  await expect(header).toHaveAttribute('aria-expanded', 'false');
  await expect(header).toHaveAttribute('aria-label', 'Recurring, 1 task');
  // Its name is its own: the default group "Upcoming" is the user's, and stays a plain group.
  await expect(page.getByRole('heading', { level: 2, name: 'Recurring', exact: true })).toHaveCount(
    1,
  );
  await expect(page.getByRole('row', { name: 'Upcoming, group, 0 tasks' })).toHaveCount(1);
  await expect(
    page.getByText(/^Completed “Water the plants” · Next: .+ · in Recurring$/),
  ).toBeVisible();
  // After the hold, the group has only its own tasks; the next instance is not in it.
  await expect.poll(() => groupTitles(page, 'Today')).toEqual(['Alpha', 'Beta']);
  await expect(row(page, 'Water the plants')).toHaveCount(0);
  await waitForSync(page);
  const next = (await myList(page, orgId)).tasks.find(
    (t) => t.title === 'Water the plants' && t.completedAt === null,
  );
  expect(next?.id).not.toBe(weekly.id);
  expect(next?.dueDate).toBe(addDays(date, 7));
  expect(next?.placement?.groupId).toBe(today);
  if (shots) await page.screenshot({ path: `${shots}/1440-upcoming-folded.png` });

  // Opening it shows the task with its date and the group it goes back to.
  await header.getByRole('heading', { name: 'Recurring' }).click();
  await expect(header).toHaveAttribute('aria-expanded', 'true');
  const upcoming = row(page, 'Water the plants');
  await expect(upcoming).toHaveAttribute('data-upcoming', 'true');
  await expect(upcoming.getByRole('button', { name: /^Due date: / })).toBeVisible();
  await expect(upcoming.getByTestId('group-chip')).toContainText('Today');
  if (shots) await page.screenshot({ path: `${shots}/1440-upcoming-open.png` });
  await expectAxeClean(page, page.url());

  // It can't be dragged (no handle, and the row body doesn't lift) or moved with keys.
  await upcoming.hover();
  await expect(upcoming.locator('[data-drag-handle]')).toHaveCount(0);
  const box = await upcoming.boundingBox();
  if (!box) throw new Error('no row');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y - 200, { steps: 8 });
  await expect(page.getByTestId('drag-layer')).toHaveCount(0);
  await page.mouse.up();
  await upcoming.locator('[data-focus-target]').focus();
  await page.keyboard.press(`${mod}+ArrowUp`);
  await expect(page.getByTestId('list-live')).toContainText(
    'Tasks in Recurring can’t be moved. Change the date to bring one back.',
  );

  // A date of today brings it back to its group, at its own place, with no move.
  await upcoming.getByRole('button', { name: /^Due date: / }).click();
  const dialog = page.getByRole('dialog', { name: 'Due date' });
  await dialog.getByRole('button', { name: /^Today/ }).click();
  await expect
    .poll(() => groupTitles(page, 'Today'))
    .toEqual(['Alpha', 'Water the plants', 'Beta']);
  await expect(page.getByTestId('upcoming-header')).toHaveCount(0);
  await waitForSync(page);
  expect(moves.map((r) => `${r.method()} ${new URL(r.url()).pathname}`)).toEqual([]);
  const back = (await myList(page, orgId)).tasks.find((t) => t.id === next?.id);
  expect(back?.dueDate).toBe(date);
  expect(back?.recurrence).toMatch(/^FREQ=WEEKLY/);
  expect(back?.placement).toEqual(next?.placement);
});

test('ADR 0068 Recurring stays open for the next visit; the smart views are unchanged', async ({
  page,
}) => {
  const { orgId, date } = await setup(page, 'upcoming.keep');
  await createTask(page, orgId, {
    title: 'Pay the rent',
    dueDate: addDays(date, 2),
    recurrence: 'FREQ=MONTHLY',
  });
  await page.reload();
  const header = page.getByTestId('upcoming-header');
  await expect(header).toHaveAttribute('aria-label', 'Recurring, 1 task');
  await expect(row(page, 'Pay the rent')).toHaveCount(0);
  await header.getByRole('button', { name: 'Expand Recurring' }).click();
  await expect(row(page, 'Pay the rent')).toBeVisible();
  await page.reload();
  await expect(row(page, 'Pay the rent')).toBeVisible();
  // Next 7 days is by date: the task shows there on its day.
  await page
    .getByRole('link', { name: /^Next 7 days/ })
    .first()
    .click();
  await expect(row(page, 'Pay the rent')).toBeVisible();
  await expect(page.getByTestId('upcoming-header')).toHaveCount(0);
});
