import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { addDays } from '@rooster/core/dates';
import type { MyList, Task, TaskDetail } from '@rooster/core/schemas';
import { apiCall } from './support/auth';
import { clickRowBody, mod, myList, waitForSync } from './support/p3';
import {
  englishUi,
  palette,
  paletteAction,
  paletteInput,
  paletteTask,
  seed,
} from './support/p5-palette';
import { viewerToday } from './support/p5-views';
import { expect, test } from './support/test';

/** Phase 5 command palette, Trash and export (WP 5.3, 5.4; AC-5.2, AC-5.3) on the desktop. */

const wcag = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const shots = process.env.ROOSTER_P5_SCREENSHOTS;

test.beforeEach(async ({ page }) => {
  await englishUi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
});

async function openPalette(page: Page) {
  await page.keyboard.press(`${mod}+k`);
  await expect(palette(page)).toBeVisible();
  await expect(paletteInput(page)).toBeFocused();
}

test('AC-5.3 Ctrl+K → ">dark" shows no results gracefully; ">move" lists the move action for the selected task', async ({
  page,
}) => {
  await seed(page, 'ac.fivethree', ['Plan the party']);
  await clickRowBody(page, 'Plan the party');
  await openPalette(page);
  await paletteInput(page).fill('>dark');
  await expect(page.getByTestId('palette-empty')).toHaveText(/No matching actions/);
  await expect(page.getByRole('option')).toHaveCount(0);

  await paletteInput(page).fill('>move');
  const move = paletteAction(page, 'Move to group…');
  await expect(move).toBeVisible();
  // Its shortcut comes from the registry.
  await expect(move.locator('kbd')).toHaveCount(1);
  await move.click();
  await expect(palette(page)).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Move task to' })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('AC-5.2 "tand" finds "Boka tandläkare" (prefix); Enter opens it; it then shows under Recent', async ({
  page,
}) => {
  const { ids } = await seed(page, 'ac.fivetwo', ['Boka tandläkare', 'Handla mat']);
  // "Tomorrow" in the viewer's own zone (what the app shows), not the machine's.
  const tomorrow = addDays(await viewerToday(page), 1);
  await apiCall(page, 'PATCH', `/api/v1/tasks/${ids[0]}`, { dueDate: tomorrow });
  await page.reload();
  await expect(page.getByRole('treegrid')).toBeVisible();
  await openPalette(page);
  await paletteInput(page).fill('tand');
  const hit = paletteTask(page, 'Boka tandläkare');
  await expect(hit).toBeVisible();
  await expect(hit.locator('mark')).toHaveText('tand');
  // 02 §12: the group chip and the due label.
  await expect(hit.getByTestId('palette-chip')).toHaveAttribute('data-kind', 'group');
  await expect(hit.getByTestId('palette-chip')).toContainText('Today');
  await expect(hit).toContainText('Tomorrow');
  await expect(paletteTask(page, 'Handla mat')).toHaveCount(0);
  if (shots) {
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${shots}/palette-results-1440.png` });
  }
  const axe = await new AxeBuilder({ page })
    .include('[data-testid="palette"]')
    .withTags(wcag)
    .analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);

  await page.keyboard.press('Enter');
  await expect(palette(page)).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/o/personal/t/${ids[0]}$`));
  await expect(page.getByTestId('pane-title')).toHaveValue('Boka tandläkare');

  await openPalette(page);
  const recent = page.getByRole('group', { name: 'Recent' });
  await expect(recent.getByTestId('palette-task')).toHaveText(/Boka tandläkare/);
  if (shots) {
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${shots}/palette-empty-1440.png` });
  }
  // Esc closes and returns focus.
  await page.keyboard.press('Escape');
  await expect(palette(page)).toHaveCount(0);
});

test('palette actions run the registry command; / opens search; clicking outside closes', async ({
  page,
}) => {
  await seed(page, 'palette.actions', ['Alpha']);
  await openPalette(page);
  await paletteInput(page).fill('>keyboard');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('complementary', { name: 'Keyboard shortcuts' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Mod+K toggles; the backdrop click closes.
  await openPalette(page);
  await page.keyboard.press(`${mod}+k`);
  await expect(palette(page)).toHaveCount(0);
  await openPalette(page);
  await page.mouse.click(20, 880);
  await expect(palette(page)).toHaveCount(0);

  // `/` opens it in search mode (no actions until ">").
  await page.getByTestId('task-row').first().locator('[data-focus-target]').focus();
  await page.keyboard.press('Escape');
  await page.keyboard.press('/');
  await expect(paletteInput(page)).toBeFocused();
  await expect(paletteInput(page)).toHaveAttribute('placeholder', 'Search tasks…');
  await expect(page.getByTestId('palette-action')).toHaveCount(0);
  await paletteInput(page).fill('>today');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/o\/personal\/today$/);

  // The sidebar's Search item opens it too.
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('button', { name: /Search/ })
    .click();
  await expect(palette(page)).toBeVisible();
});

test('Make subtask of… re-parents the selection under the picked task', async ({ page }) => {
  const { orgId, ids } = await seed(page, 'palette.subtask', ['Parent task', 'Child task']);
  await clickRowBody(page, 'Child task');
  await openPalette(page);
  await paletteInput(page).fill('>subtask of');
  await paletteAction(page, 'Make subtask of…').click();
  await expect(paletteInput(page)).toHaveAttribute('placeholder', /subtask of/);
  // The selection itself is never offered.
  await expect(paletteTask(page, 'Child task')).toHaveCount(0);
  await paletteInput(page).fill('Parent');
  await expect(paletteTask(page, 'Parent task')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(palette(page)).toHaveCount(0);
  await waitForSync(page);
  await expect
    .poll(async () => (await myList(page, orgId)).tasks.find((t) => t.id === ids[1])?.parentId)
    .toBe(ids[0]);
});

test('offline: the palette filters cached tasks and says so', async ({ page, context }) => {
  await seed(page, 'palette.offline', ['Boka tandläkare', 'Handla mat']);
  // Dev serves modules unbundled; in production the service worker precaches the chunk.
  await openPalette(page);
  await page.keyboard.press('Escape');
  await context.setOffline(true);
  await openPalette(page);
  await paletteInput(page).fill('tand');
  await expect(page.getByTestId('palette-offline')).toHaveText(/Offline/);
  await expect(paletteTask(page, 'Boka tandläkare')).toBeVisible();
  await expect(paletteTask(page, 'Boka tandläkare').locator('mark')).toHaveText('tand');
  await expect(paletteTask(page, 'Handla mat')).toHaveCount(0);
  await context.setOffline(false);
});

test('Mod+K in the description editor with text selected stays the link shortcut', async ({
  page,
}) => {
  await seed(page, 'palette.editor', ['Linked']);
  await clickRowBody(page, 'Linked');
  const editor = page.getByTestId('description-field').locator('[contenteditable="true"]');
  await editor.click();
  await page.keyboard.type('docs');
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.press(`${mod}+k`);
  await expect(palette(page)).toHaveCount(0);
});

test('Trash (Settings → Data): restore and delete permanently, with an inline confirm', async ({
  page,
}) => {
  const { orgId, ids } = await seed(page, 'palette.trash', ['Restore me', 'Destroy me']);
  for (const id of ids)
    expect((await apiCall(page, 'DELETE', `/api/v1/tasks/${id}`)).status()).toBe(204);
  await page.goto('/settings/data');
  const rows = page.getByTestId('trash-row');
  await expect(rows).toHaveCount(2);
  // Newest deleted first.
  await expect(rows.first()).toContainText('Destroy me');
  await expect(rows.first()).toContainText('Deleted by you');
  if (shots) await page.screenshot({ path: `${shots}/settings-data-1440.png`, fullPage: true });
  const axe = await new AxeBuilder({ page }).include('main').withTags(wcag).analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);

  await page.getByRole('button', { name: 'Restore Restore me' }).click();
  await expect(rows).toHaveCount(1);
  await expect(page.getByText('Restored “Restore me”')).toBeVisible();
  const list: MyList = await myList(page, orgId);
  expect(list.tasks.some((t: Task) => t.id === ids[0])).toBe(true);

  await page.getByRole('button', { name: 'Delete Destroy me permanently' }).click();
  const cancel = page.getByRole('button', { name: 'Cancel' });
  await expect(cancel).toBeFocused();
  await cancel.click();
  await expect(page.getByRole('button', { name: 'Delete Destroy me permanently' })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByTestId('trash-empty')).toBeVisible();
  const gone = await apiCall(page, 'GET', `/api/v1/tasks/${ids[1]}`);
  expect(gone.status()).toBe(404);
  const restored = (await (
    await apiCall(page, 'GET', `/api/v1/tasks/${ids[0]}`)
  ).json()) as TaskDetail;
  expect(restored.title).toBe('Restore me');
});

test('Export downloads JSON and Markdown for the org', async ({ page }) => {
  await seed(page, 'palette.export', ['Exported task']);
  await openPalette(page);
  await paletteInput(page).fill('>export');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/settings\/data\?org=personal$/);

  const [json] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-json').click(),
  ]);
  expect(json.suggestedFilename()).toMatch(/^rooster-.+-\d{4}-\d{2}-\d{2}\.json$/);
  const data = JSON.parse(await readFile((await json.path()) as string, 'utf8')) as {
    format: string;
    tasks: { title: string }[];
  };
  expect(data.format).toBe('rooster-export');
  expect(data.tasks.map((t) => t.title)).toContain('Exported task');

  const [markdown] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-markdown').click(),
  ]);
  expect(markdown.suggestedFilename()).toMatch(/\.md$/);
});

test('kitchen sink: the palette and Trash states render without axe violations', async ({
  page,
}) => {
  await page.goto('/_dev/ui#palette');
  const section = page.getByTestId('section-palette');
  await expect(section.getByRole('heading', { level: 2, name: 'Command palette' })).toBeVisible();
  await expect(section.getByTestId('palette-empty')).toHaveText(/No matching actions/);
  await expect(section.locator('mark').first()).toHaveText('dent');
  await expect(section.getByTestId('palette-offline')).toBeVisible();
  await expect(section.getByTestId('trash-row')).toHaveCount(2);
  const axe = await new AxeBuilder({ page }).include('#palette').withTags(wcag).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' | ')}`)).toEqual(
    [],
  );
});

test('searching all organisations shows the org chip for hits in another org', async ({ page }) => {
  await seed(page, 'palette.orgs', ['Boka tandläkare']);
  const created = await apiCall(page, 'POST', '/api/v1/orgs', { name: 'Tandklubben' });
  expect(created.status(), await created.text()).toBe(201);
  const other = (await created.json()) as { id: string };
  const task = await apiCall(page, 'POST', `/api/v1/orgs/${other.id}/tasks`, {
    title: 'Tandkräm till klubben',
  });
  expect(task.status()).toBe(201);
  await page.reload();
  await expect(page.getByTestId('task-row').first()).toBeVisible();

  await openPalette(page);
  await paletteInput(page).fill('tand');
  await expect(paletteTask(page, 'Boka tandläkare')).toBeVisible();
  await expect(paletteTask(page, 'Tandkräm till klubben')).toHaveCount(0);
  await expect(paletteTask(page, 'Boka tandläkare').getByTestId('palette-chip')).toHaveAttribute(
    'data-kind',
    'group',
  );

  await page.getByTestId('palette-scope').click();
  const theirs = paletteTask(page, 'Tandkräm till klubben');
  await expect(theirs).toBeVisible();
  await expect(theirs.getByTestId('palette-chip')).toHaveAttribute('data-kind', 'org');
  await expect(theirs.getByTestId('palette-chip')).toContainText('Tandklubben');
  // The current org's hit keeps its group chip.
  await expect(paletteTask(page, 'Boka tandläkare').getByTestId('palette-chip')).toContainText(
    'Today',
  );
});
