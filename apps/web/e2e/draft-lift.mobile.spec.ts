import type { Page, Request } from '@playwright/test';
import { signInAs, uniqueEmail } from './support/auth';
import { createTask, groupId, myList, personalOrg, waitForSync } from './support/p3';
import { expect, reload, test } from './support/test';
import { longPress, showKeyboard } from './support/touch';

/**
 * ADR 0069 on phones: a long-press on a new row's title, once it has text, creates the task
 * (as Enter would; the keyboard closes) and lifts the row, which then drops like any other.
 * Released without moving, the new task enters selection mode; an empty title does nothing.
 */

const shots = process.env.ROOSTER_DRAFT_LIFT_SCREENSHOTS;

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

function writes(page: Page): Request[] {
  const seen: Request[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && request.url().includes('/api/v1/')) seen.push(request);
  });
  return seen;
}

/** Today: "Today 1"; Prio: "Prio 1", "Prio 2". */
async function setup(page: Page, name: string) {
  // Both phone projects start workers in the same millisecond: keep their users apart.
  const project = test.info().project.name.replaceAll('-', '.');
  await signInAs(page, uniqueEmail(`${name}.${project}`));
  const orgId = await personalOrg(page);
  const today = await groupId(page, orgId, 'Today');
  const prio = await groupId(page, orgId, 'Prio');
  await createTask(page, orgId, { title: 'Today 1', groupId: today });
  const p1 = await createTask(page, orgId, { title: 'Prio 1', groupId: prio });
  await createTask(page, orgId, { title: 'Prio 2', groupId: prio, afterId: p1.id, beforeId: null });
  await reload(page);
  await expect(row(page, 'Prio 2')).toBeVisible({ timeout: 15_000 });
  return { orgId, today, prio };
}

/** The FAB's new row at the top of Today, typed into with the keyboard up. */
async function newRow(page: Page, title: string) {
  await page.getByRole('button', { name: 'New task' }).tap();
  const input = page.locator('[data-list-input]');
  await expect(input).toBeFocused();
  await showKeyboard(page, 300);
  if (title) await input.fill(title);
  return input;
}

async function titlesIn(page: Page, orgId: string, group: string) {
  const list = await myList(page, orgId);
  return list.tasks
    .filter((t) => t.placement?.groupId === group && t.completedAt === null)
    .sort((a, b) => ((a.placement?.position ?? '') < (b.placement?.position ?? '') ? -1 : 1))
    .map((t) => t.title);
}

test('ADR 0069 a long-press on a new row’s title creates the task and drags it to another group', async ({
  page,
}) => {
  const { orgId, today, prio } = await setup(page, 'draft.lift');
  const input = await newRow(page, 'Buy milk');
  const target = await row(page, 'Prio 1').boundingBox();
  if (!target) throw new Error('no target');
  // Into Prio, below "Prio 1".
  await longPress(page, input, {
    x: target.x + target.width / 2 - 40,
    y: target.y + target.height * 0.75,
  });
  // The edit is over (the keyboard closed) and the row is a task, dropped in place.
  await expect(page.locator('[data-draft]')).toHaveCount(0);
  await expect(page.locator('[data-list-input]')).toHaveCount(0);
  await expect(row(page, 'Buy milk')).toHaveCount(1);
  await expect(page.getByTestId('drag-layer')).toHaveCount(0);
  await expect.poll(() => titlesIn(page, orgId, prio)).toEqual(['Prio 1', 'Buy milk', 'Prio 2']);
  expect(await titlesIn(page, orgId, today)).toEqual(['Today 1']);
  const created = (await myList(page, orgId)).tasks.filter((t) => t.title === 'Buy milk');
  expect(created).toHaveLength(1);
  if (shots) await page.screenshot({ path: `${shots}/390-draft-lift-dropped.png` });

  // Two steps (02 §3.7): Undo takes back the move, then the creation.
  // Both profiles report a Linux platform here, so the app's Mod is Ctrl.
  const undo = 'Control+z';
  await page.keyboard.press(undo);
  await expect.poll(() => titlesIn(page, orgId, today)).toEqual(['Buy milk', 'Today 1']);
  await page.keyboard.press(undo);
  await expect.poll(() => titlesIn(page, orgId, today)).toEqual(['Today 1']);
  await waitForSync(page);
  expect((await myList(page, orgId)).tasks.some((t) => t.title === 'Buy milk')).toBe(false);
});

test('ADR 0069 a still long-press creates the task and selects it; an empty title does nothing', async ({
  page,
}) => {
  const { orgId, today } = await setup(page, 'draft.still');
  const sent = writes(page);
  // Empty: native behaviour, no task, no selection, the edit goes on.
  const empty = await newRow(page, '');
  await longPress(page, empty);
  await expect(page.getByTestId('selection-header')).toHaveCount(0);
  await expect(page.getByTestId('drag-layer')).toHaveCount(0);
  await expect(empty).toBeFocused();
  await expect(page.locator('[data-draft]')).toHaveCount(1);
  await waitForSync(page);
  expect(sent).toEqual([]);

  // With a title: created where it was typed, then selection mode, as on any row.
  await empty.fill('Call mom');
  await longPress(page, empty);
  await expect(page.getByTestId('selection-header')).toContainText('1 selected');
  await expect(page.locator('[data-draft]')).toHaveCount(0);
  await expect(row(page, 'Call mom')).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => titlesIn(page, orgId, today)).toEqual(['Call mom', 'Today 1']);
  if (shots) await page.screenshot({ path: `${shots}/390-draft-lift-selected.png` });
});
