import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { nextWeekday, todayIn } from '@rooster/core/dates';
import type { Group, MyList, Task } from '@rooster/core/schemas';
import { apiCall, newClient, signInAs, uniqueEmail } from './support/auth';
import { expect, test } from './support/test';

/** Phase 2 acceptance criteria (09 §Phase 2) for the list, against the real server. */

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

interface Session {
  orgId: string;
  timezone: string;
}

async function session(page: Page): Promise<Session> {
  const me = (await (await apiCall(page, 'GET', '/api/v1/me')).json()) as {
    timezone: string;
    orgs: { id: string; isPersonal: boolean }[];
  };
  const org = me.orgs.find((o) => o.isPersonal);
  if (!org) throw new Error('no personal org');
  return { orgId: org.id, timezone: me.timezone };
}

async function myList(page: Page, orgId: string): Promise<MyList> {
  const res = await apiCall(page, 'GET', `/api/v1/orgs/${orgId}/my-list`);
  expect(res.status()).toBe(200);
  return (await res.json()) as MyList;
}

function byPosition<T extends { id: string; position: string }>(items: T[]): T[] {
  return [...items].sort((a, b) =>
    a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : 1,
  );
}

/** Open task titles per group name, in server order. */
async function serverOrder(page: Page, orgId: string): Promise<Record<string, string[]>> {
  const list = await myList(page, orgId);
  const out: Record<string, string[]> = {};
  for (const group of list.groups) {
    const tasks = list.tasks
      .filter((t) => t.placement?.groupId === group.id && t.completedAt === null)
      .map((t) => ({ ...t, position: t.placement?.position ?? '' }));
    out[group.name] = byPosition(tasks).map((t) => t.title);
  }
  return out;
}

async function groupByName(page: Page, orgId: string, name: string): Promise<Group> {
  const group = (await myList(page, orgId)).groups.find((g) => g.name === name);
  if (!group) throw new Error(`no group ${name}`);
  return group;
}

async function createTasks(page: Page, orgId: string, groupName: string, titles: string[]) {
  const group = await groupByName(page, orgId, groupName);
  const created: Task[] = [];
  for (const title of titles) {
    const res = await apiCall(page, 'POST', `/api/v1/orgs/${orgId}/tasks`, {
      title,
      groupId: group.id,
      afterId: null,
      beforeId: null,
    });
    expect(res.status()).toBe(201);
    created.push((await res.json()) as Task);
  }
  return created;
}

/** The pipeline publishes its queue length; wait until every op reached the server. */
async function waitForSync(page: Page) {
  await expect(page.getByTestId('sync-state')).toHaveAttribute('data-pending', '0');
}

function rows(page: Page): Locator {
  return page.getByTestId('task-row');
}

function header(page: Page, name: string): Locator {
  return page
    .getByTestId('group-header')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });
}

/** Visible task titles of a group, in screen order. */
async function visibleTitles(page: Page, groupName: string): Promise<string[]> {
  return page.evaluate((name) => {
    const out: string[] = [];
    let inGroup = false;
    for (const row of document.querySelectorAll<HTMLElement>('[data-list-root] [data-row-id]')) {
      if (row.dataset.testid === 'group-header') {
        inGroup = row.querySelector('h2')?.textContent === name;
      } else if (inGroup && row.dataset.testid === 'task-row') {
        const input = row.querySelector('input[data-list-input]') as HTMLInputElement | null;
        out.push(
          input ? input.value : (row.querySelector('[data-focus-target]')?.textContent ?? ''),
        );
      }
    }
    return out;
  }, groupName);
}

async function openList(page: Page, name: string) {
  await signInAs(page, uniqueEmail(name));
  await expect(page.getByRole('treegrid')).toBeVisible();
  return session(page);
}

test('AC-2.1 typing two tasks with Enter creates them in order; "fri" becomes the due date', async ({
  page,
}) => {
  const { orgId, timezone } = await openList(page, 'ac.twoone');
  await page.getByRole('button', { name: 'Add task' }).first().click();
  await page.keyboard.type('Buy milk');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Call Bob fri');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect.poll(() => visibleTitles(page, 'Today')).toEqual(['Buy milk', 'Call Bob']);
  await waitForSync(page);

  const list = await myList(page, orgId);
  const bob = list.tasks.find((t) => t.title === 'Call Bob');
  const friday = nextWeekday(todayIn(timezone, Date.now()), 5);
  expect(bob?.dueDate).toBe(friday);
  expect((await serverOrder(page, orgId)).Today).toEqual(['Buy milk', 'Call Bob']);

  await page.reload();
  await expect.poll(() => visibleTitles(page, 'Today')).toEqual(['Buy milk', 'Call Bob']);
});

test('AC-2.2 Shift+Enter inserts above; Ctrl+↑/↓ and Ctrl+Shift+↓ reorder, the same everywhere', async ({
  page,
  browser,
}) => {
  const email = uniqueEmail('ac.twotwo');
  await signInAs(page, email);
  const { orgId } = await session(page);
  await createTasks(page, orgId, 'Today', ['A', 'C']);
  await page.reload();
  await expect.poll(() => visibleTitles(page, 'Today')).toEqual(['A', 'C']);

  // Edit C, Shift+Enter → a new row above C.
  await rows(page).filter({ hasText: 'C' }).getByText('C', { exact: true }).click();
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('B');
  await page.keyboard.press('Escape');
  await expect.poll(() => visibleTitles(page, 'Today')).toEqual(['A', 'B', 'C']);

  // Navigate on B: Ctrl+↑ → B, A, C; Ctrl+↓ → A, B, C.
  await page.keyboard.press(`${mod}+ArrowUp`);
  await expect.poll(() => visibleTitles(page, 'Today')).toEqual(['B', 'A', 'C']);
  await page.keyboard.press(`${mod}+ArrowDown`);
  await expect.poll(() => visibleTitles(page, 'Today')).toEqual(['A', 'B', 'C']);
  // Ctrl+Shift+↓ → B to the start of Prio.
  await page.keyboard.press(`${mod}+Shift+ArrowDown`);
  await expect.poll(() => visibleTitles(page, 'Prio')).toEqual(['B']);
  await expect.poll(() => visibleTitles(page, 'Today')).toEqual(['A', 'C']);
  await waitForSync(page);

  const expected = { Today: ['A', 'C'], Prio: ['B'] };
  expect(await serverOrder(page, orgId)).toMatchObject(expected);
  await page.reload();
  await expect.poll(() => visibleTitles(page, 'Today')).toEqual(['A', 'C']);
  await expect.poll(() => visibleTitles(page, 'Prio')).toEqual(['B']);

  const other = await (await newClient(browser)).newPage();
  await signInAs(other, email);
  await expect.poll(() => visibleTitles(other, 'Today')).toEqual(['A', 'C']);
  await expect.poll(() => visibleTitles(other, 'Prio')).toEqual(['B']);
});

test('AC-2.3 drag into a collapsed group (hover expands) and keyboard drag, both announced', async ({
  page,
}) => {
  const { orgId } = await openList(page, 'ac.twothree');
  await createTasks(page, orgId, 'Prio', ['P1', 'P2']);
  await createTasks(page, orgId, 'Upcoming', ['U1', 'U2']);
  await page.reload();
  await header(page, 'Upcoming').getByRole('button', { name: 'Collapse Upcoming' }).click();
  await expect(header(page, 'Upcoming')).toHaveAttribute('aria-expanded', 'false');

  const source = rows(page).filter({ hasText: 'P1' });
  const box = await source.boundingBox();
  if (!box) throw new Error('no box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 10, { steps: 4 });
  await expect(page.getByTestId('list-live')).toContainText('Picked up P1');
  const target = header(page, 'Upcoming');
  const tbox = await target.boundingBox();
  if (!tbox) throw new Error('no header box');
  await page.mouse.move(tbox.x + tbox.width / 2, tbox.y + tbox.height / 2, { steps: 8 });
  // Hovering a collapsed header for 600 ms opens it.
  await expect(target).toHaveAttribute('aria-expanded', 'true', { timeout: 3000 });
  const u2 = rows(page).filter({ hasText: 'U2' });
  const ubox = await u2.boundingBox();
  if (!ubox) throw new Error('no U2 box');
  // Upper half of U2 → between U1 and U2.
  await page.mouse.move(ubox.x + ubox.width / 2, ubox.y + 8, { steps: 6 });
  await expect(page.getByTestId('drop-indicator')).toBeVisible();
  await page.mouse.up();
  await expect.poll(() => visibleTitles(page, 'Upcoming')).toEqual(['U1', 'P1', 'U2']);
  await expect(page.getByTestId('list-live')).toContainText('Moved to Upcoming, position 2 of 3');

  // Keyboard drag: focus P2's handle, Space, ↑, Space.
  await createTasks(page, orgId, 'Prio', ['P3']);
  await page.reload();
  await expect.poll(() => visibleTitles(page, 'Prio')).toEqual(['P2', 'P3']);
  await page.getByRole('button', { name: 'Move P3' }).focus();
  await page.keyboard.press('Space');
  await expect(page.getByTestId('list-live')).toContainText(
    'Picked up P3. Position 2 of 2 in Prio',
  );
  await page.keyboard.press('ArrowUp');
  await expect(page.getByTestId('list-live')).toContainText('P3 is at position 1 of 2 in Prio');
  await page.keyboard.press('Space');
  await expect.poll(() => visibleTitles(page, 'Prio')).toEqual(['P3', 'P2']);
  await expect(page.getByTestId('list-live')).toContainText('Moved to Prio, position 1 of 2');
  await waitForSync(page);
  expect((await serverOrder(page, orgId)).Prio).toEqual(['P3', 'P2']);
});

test('AC-2.4 dragging a group header reorders groups; the Inbox is fixed and hidden when empty', async ({
  page,
}) => {
  const { orgId } = await openList(page, 'ac.twofour');
  await expect(header(page, 'Inbox')).toHaveCount(0);
  const upcoming = header(page, 'Upcoming');
  const today = header(page, 'Today');
  const from = await upcoming.boundingBox();
  const to = await today.boundingBox();
  if (!from || !to) throw new Error('no boxes');
  await page.mouse.move(from.x + 200, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 200, from.y + from.height / 2 - 10, { steps: 4 });
  // All groups collapse during a group drag.
  const collapsedToday = await today.boundingBox();
  if (!collapsedToday) throw new Error('no box');
  await page.mouse.move(from.x + 200, collapsedToday.y + 6, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId('group-header').getByRole('heading')).toHaveText([
    'Upcoming',
    'Today',
    'Prio',
  ]);
  await waitForSync(page);
  const order = byPosition((await myList(page, orgId)).groups.filter((g) => g.kind === 'normal'));
  expect(order.map((g) => g.name)).toEqual(['Upcoming', 'Today', 'Prio']);

  // A task in the Inbox shows it, first, without a drag handle or menu.
  const inbox = (await myList(page, orgId)).groups.find((g) => g.kind === 'inbox');
  await apiCall(page, 'POST', `/api/v1/orgs/${orgId}/tasks`, { title: 'From CLI' });
  await page.reload();
  await expect(page.getByTestId('group-header').first()).toContainText('Inbox');
  await expect(header(page, 'Inbox').getByRole('button', { name: /options/ })).toHaveCount(0);
  const move = await apiCall(page, 'POST', `/api/v1/groups/${inbox?.id}/move`, { afterId: null });
  expect(move.status()).toBe(409);
});

test('AC-2.5 completing pops, hides after 1.5 s with an undo toast; undo and Ctrl+Z restore the position', async ({
  page,
}) => {
  const { orgId } = await openList(page, 'ac.twofive');
  await createTasks(page, orgId, 'Today', ['One', 'Two', 'Three']);
  await page.reload();
  const two = rows(page).filter({ hasText: 'Two' });
  await two.locator('label').click();
  await expect(two).toHaveAttribute('data-done', 'true');
  await expect(page.getByRole('status').filter({ hasText: 'Completed “Two”' })).toBeVisible();
  await expect(two).toHaveCount(1);
  await expect(two).toHaveCount(0, { timeout: 3000 });
  await expect.poll(() => visibleTitles(page, 'Today')).toEqual(['One', 'Three']);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => visibleTitles(page, 'Today')).toEqual(['One', 'Two', 'Three']);

  // Ctrl+Enter, then Ctrl+Z.
  await rows(page).filter({ hasText: 'Three' }).locator('[data-drag-handle]').click();
  await page.keyboard.press(`${mod}+Enter`);
  await expect.poll(() => visibleTitles(page, 'Today'), { timeout: 4000 }).toEqual(['One', 'Two']);
  await page.keyboard.press(`${mod}+z`);
  await expect.poll(() => visibleTitles(page, 'Today')).toEqual(['One', 'Two', 'Three']);
  await waitForSync(page);
  expect((await serverOrder(page, orgId)).Today).toEqual(['One', 'Two', 'Three']);
});

test('AC-2.6 Backspace deletes only one fresh empty row even when held; content is protected', async ({
  page,
}) => {
  const { orgId } = await openList(page, 'ac.twosix');
  const [, kept] = await createTasks(page, orgId, 'Today', ['Keep me', 'Has notes']);
  await apiCall(page, 'PATCH', `/api/v1/tasks/${kept?.id}`, { description: 'Important notes' });
  await page.reload();

  // A fresh draft under "Keep me"; hold Backspace (auto-repeat).
  await rows(page).filter({ hasText: 'Keep me' }).getByText('Keep me').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(rows(page)).toHaveCount(3);
  await page.keyboard.down('Backspace');
  for (let i = 0; i < 8; i++) await page.keyboard.down('Backspace');
  await page.keyboard.up('Backspace');
  await expect(rows(page)).toHaveCount(2);
  await expect.poll(() => visibleTitles(page, 'Today')).toEqual(['Keep me', 'Has notes']);
  await page.keyboard.press('Escape');

  // Emptying the title of a task with a description, then Backspace: kept, with a hint.
  await rows(page).filter({ hasText: 'Has notes' }).getByText('Has notes').click();
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await expect(page.getByText('Use Tab+Delete to delete tasks with content')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(rows(page)).toHaveCount(2);
  await waitForSync(page);
  const titles = (await myList(page, orgId)).tasks.map((t) => t.title).sort();
  expect(titles).toEqual(['Has notes', 'Keep me']);
});

test('AC-2.8 Tab+N on the 2nd of 4 tasks splits the group; one undo reverts it', async ({
  page,
}) => {
  const { orgId } = await openList(page, 'ac.twoeight');
  await createTasks(page, orgId, 'Today', ['T1', 'T2', 'T3', 'T4']);
  await page.reload();
  await rows(page).filter({ hasText: 'T2' }).locator('[data-drag-handle]').click();
  await page.keyboard.down('Tab');
  await page.keyboard.press('n');
  await page.keyboard.up('Tab');
  const name = page.getByRole('textbox', { name: 'Group name' });
  await expect(name).toBeFocused();
  await page.keyboard.type('Later');
  await page.keyboard.press('Enter');
  await expect.poll(() => visibleTitles(page, 'Today')).toEqual(['T1', 'T2']);
  await expect.poll(() => visibleTitles(page, 'Later')).toEqual(['T3', 'T4']);
  await waitForSync(page);
  expect(await serverOrder(page, orgId)).toMatchObject({
    Today: ['T1', 'T2'],
    Later: ['T3', 'T4'],
  });

  // One undo for the rename, one for the split (the split is a single entry).
  await page.keyboard.press(`${mod}+z`);
  await page.keyboard.press(`${mod}+z`);
  await expect(header(page, 'Later')).toHaveCount(0);
  await expect(page.getByTestId('group-header').filter({ hasText: 'New group' })).toHaveCount(0);
  await expect.poll(() => visibleTitles(page, 'Today')).toEqual(['T1', 'T2', 'T3', 'T4']);
  await waitForSync(page);
  expect((await serverOrder(page, orgId)).Today).toEqual(['T1', 'T2', 'T3', 'T4']);
});

test('AC-2.9 deleting a group moves its tasks to Prio, or deletes them and restores both', async ({
  page,
}) => {
  const { orgId } = await openList(page, 'ac.twonine');
  await createTasks(page, orgId, 'Prio', ['P1']);
  await createTasks(page, orgId, 'Upcoming', ['U1', 'U2']);
  await page.reload();

  await header(page, 'Upcoming').hover();
  await header(page, 'Upcoming').getByRole('button', { name: 'Upcoming options' }).click();
  await page.getByRole('menuitem', { name: 'Delete group' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete “Upcoming”?' });
  await expect(dialog.getByRole('radio', { name: 'Move 2 tasks to:' })).toBeChecked();
  await dialog.getByRole('button', { name: /Prio/ }).click();
  await page.getByRole('option', { name: 'Prio' }).click();
  await dialog.getByRole('button', { name: 'Delete group' }).click();
  await expect(header(page, 'Upcoming')).toHaveCount(0);
  await expect.poll(() => visibleTitles(page, 'Prio')).toEqual(['P1', 'U1', 'U2']);
  await waitForSync(page);
  expect((await serverOrder(page, orgId)).Prio).toEqual(['P1', 'U1', 'U2']);

  // Delete Prio with its tasks, then restore both via Undo.
  await header(page, 'Prio').hover();
  await header(page, 'Prio').getByRole('button', { name: 'Prio options' }).click();
  await page.getByRole('menuitem', { name: 'Delete group' }).click();
  const second = page.getByRole('dialog', { name: 'Delete “Prio”?' });
  await second.getByText('Delete the tasks too').click();
  await second.getByRole('button', { name: 'Delete group' }).click();
  await expect(header(page, 'Prio')).toHaveCount(0);
  await waitForSync(page);
  const trash = await apiCall(page, 'GET', `/api/v1/orgs/${orgId}/trash`);
  const trashed = ((await trash.json()) as { items: Task[] }).items.map((t) => t.title).sort();
  expect(trashed).toEqual(['P1', 'U1', 'U2']);
  await page.getByRole('button', { name: 'Undo' }).last().click();
  await expect(header(page, 'Prio')).toHaveCount(1);
  await expect.poll(() => visibleTitles(page, 'Prio')).toEqual(['P1', 'U1', 'U2']);
  await waitForSync(page);
  expect((await serverOrder(page, orgId)).Prio).toEqual(['P1', 'U1', 'U2']);
});

test('keyboard paths: D dates, M moves with a digit, F2 renames, Alt+click collapses all, ? and Shift+H', async ({
  page,
}) => {
  const { orgId } = await openList(page, 'list.keys');
  await createTasks(page, orgId, 'Today', ['Alpha', 'Beta']);
  await page.reload();
  await rows(page).filter({ hasText: 'Alpha' }).locator('[data-drag-handle]').click();

  // D opens the date popover on the row; a chip sets the date and closes it.
  await page.keyboard.press('d');
  const picker = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('button', { name: /Tomorrow/ }) });
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: /Tomorrow/ }).click();
  await expect(rows(page).filter({ hasText: 'Alpha' })).toContainText('Tomorrow');

  // M + 3 → the third group in the list (Prio; the Inbox is empty and hidden).
  await rows(page).filter({ hasText: 'Alpha' }).locator('[data-drag-handle]').click();
  await page.keyboard.press('m');
  await expect(page.getByRole('combobox', { name: 'Filter groups' })).toBeFocused();
  await page.keyboard.press('3');
  await expect.poll(() => visibleTitles(page, 'Prio')).toEqual(['Alpha']);

  // F2 on a header renames it.
  await header(page, 'Upcoming').click({ position: { x: 600, y: 20 } });
  await page.keyboard.press('F2');
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.type('Someday');
  await page.keyboard.press('Enter');
  await expect(header(page, 'Someday')).toHaveCount(1);

  // Alt+click on a chevron collapses every group.
  await header(page, 'Today')
    .getByRole('button', { name: 'Collapse Today' })
    .click({ modifiers: ['Alt'] });
  for (const name of ['Today', 'Prio', 'Someday']) {
    await expect(header(page, name)).toHaveAttribute('aria-expanded', 'false');
  }
  await header(page, 'Today')
    .getByRole('button', { name: 'Expand Today' })
    .click({ modifiers: ['Alt'] });
  await expect(header(page, 'Prio')).toHaveAttribute('aria-expanded', 'true');

  // Complete Beta, then Shift+H shows it struck through in place.
  await rows(page).filter({ hasText: 'Beta' }).locator('label').click();
  await expect(rows(page).filter({ hasText: 'Beta' })).toHaveCount(0, { timeout: 4000 });
  await page.locator('body').click({ position: { x: 5, y: 500 } });
  await page.keyboard.press('Shift+H');
  await expect(rows(page).filter({ hasText: 'Beta' })).toHaveAttribute('data-done', 'true');

  // ? opens the cheat sheet generated from the keymap; Esc closes it.
  await page.keyboard.press('?');
  const sheet = page.getByRole('complementary', { name: 'Keyboard shortcuts' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('New group at the cursor')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
});

test('My tasks has no axe violations (WCAG 2.2 AA)', async ({ page }) => {
  const { orgId } = await openList(page, 'list.axe');
  await createTasks(page, orgId, 'Today', ['Alpha', 'Beta']);
  await apiCall(page, 'POST', `/api/v1/orgs/${orgId}/tasks`, { title: 'In the inbox' });
  await page.reload();
  await expect(rows(page)).toHaveCount(3);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`),
  ).toEqual([]);
});
