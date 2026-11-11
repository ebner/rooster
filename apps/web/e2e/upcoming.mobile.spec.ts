import type { Page } from '@playwright/test';
import { addDays, todayIn } from '@rooster/core/dates';
import { expectAxeClean } from './support/a11y';
import { apiCall, signInAs, uniqueEmail } from './support/auth';
import { createTask, groupId, myList, personalOrg, waitForSync } from './support/p3';
import { expect, reload, test } from './support/test';
import { longPress, swipe } from './support/touch';

/**
 * ADR 0068 (FR-REC-5) on phones: the folded Upcoming section at the end of My tasks opens with
 * a tap; its rows swipe and select like any other but never lift; a date of today brings a
 * task back to its group, at its own place.
 */

const shots = process.env.ROOSTER_UPCOMING_SCREENSHOTS;

test.beforeEach(async ({ page }) => {
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

/** The titles of one group's rows, in order. */
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

test('ADR 0068 Recurring on a phone: a tap opens it, its rows never lift, today brings one back', async ({
  page,
}) => {
  // Both phone projects start workers in the same millisecond: keep their users apart.
  const project = test.info().project.name.replaceAll('-', '.');
  await signInAs(page, uniqueEmail(`upcoming.${project}`));
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
  await reload(page);
  await expect(row(page, 'Beta')).toBeVisible({ timeout: 15_000 });

  await row(page, 'Water the plants').locator('label').first().tap();
  const header = page.getByTestId('upcoming-header');
  await expect(header).toHaveAttribute('aria-expanded', 'false');
  await expect(header).toHaveAttribute('aria-label', 'Recurring, 1 task');
  await expect.poll(() => groupTitles(page, 'Today')).toEqual(['Alpha', 'Beta']);
  await waitForSync(page);
  const next = (await myList(page, orgId)).tasks.find(
    (t) => t.title === 'Water the plants' && t.completedAt === null,
  );
  expect(next?.dueDate).toBe(addDays(date, 7));
  if (shots) {
    await header.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${shots}/390-upcoming-folded.png` });
  }

  await header.tap();
  await expect(header).toHaveAttribute('aria-expanded', 'true');
  const upcoming = row(page, 'Water the plants');
  await expect(upcoming).toHaveAttribute('data-upcoming', 'true');
  await expect(upcoming.getByRole('button', { name: /^Due date: / })).toBeVisible();
  // At the end of the list its bottom padding keeps every row clear of the FAB (as in the
  // a11y phone spec); mid-scroll the FAB covers part of a row.
  await page.evaluate(() => {
    let el = document.querySelector('[data-list-root]')?.parentElement ?? null;
    while (el && el.scrollHeight <= el.clientHeight) el = el.parentElement;
    el?.scrollTo({ top: el.scrollHeight });
  });
  if (shots) await page.screenshot({ path: `${shots}/390-upcoming-open.png` });
  await expectAxeClean(page, page.url());
  await upcoming.evaluate((el) => el.scrollIntoView({ block: 'center' }));

  // A long-press and a drag lift nothing; a still long-press selects it, as on any row.
  const box = await upcoming.boundingBox();
  if (!box) throw new Error('no row');
  await longPress(page, upcoming, { x: box.x + box.width / 2 - 40, y: box.y - 150 });
  await expect(page.getByTestId('drag-layer')).toHaveCount(0);
  await expect(page.getByTestId('selection-header')).toHaveCount(0);
  await longPress(page, upcoming);
  await expect(page.getByTestId('selection-header')).toContainText('1 selected');
  await page.getByRole('button', { name: 'Done selecting' }).click();
  await expect(page.getByTestId('selection-header')).toHaveCount(0);

  // Swipe left: the date sheet; today brings it back to its group, at its own place.
  await swipe(page, upcoming, -0.6);
  const sheet = page.getByRole('dialog', { name: 'Due date' });
  await sheet.getByRole('button', { name: /^Today/ }).click();
  await expect(sheet).toHaveCount(0);
  await expect
    .poll(() => groupTitles(page, 'Today'))
    .toEqual(['Alpha', 'Water the plants', 'Beta']);
  await expect(page.getByTestId('upcoming-header')).toHaveCount(0);
  await waitForSync(page);
  const back = (await myList(page, orgId)).tasks.find((t) => t.id === next?.id);
  expect(back?.dueDate).toBe(date);
  expect(back?.placement).toEqual(next?.placement);
});
