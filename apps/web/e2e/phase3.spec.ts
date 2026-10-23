import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import type { Task, TaskDetail } from '@rooster/core/schemas';
import { apiCall, signInAs, uniqueEmail } from './support/auth';
import {
  clickRowBody,
  createTask,
  groupId,
  mod,
  myList,
  personalOrg,
  tags,
  waitForSync,
} from './support/p3';
import { expect, test } from './support/test';

/** Phase 3 acceptance criteria (09 §Phase 3) for the web client, against the real server. */

const pane = (page: Page) => page.getByTestId('detail-pane');
const row = (page: Page, title: string) =>
  page.getByTestId('task-row').filter({ hasText: title }).first();

async function setup(page: Page, name: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInAs(page, uniqueEmail(name));
  await expect(page.getByRole('treegrid')).toBeVisible();
  const orgId = await personalOrg(page);
  const today = await groupId(page, orgId, 'Today');
  return { orgId, today };
}

async function detail(page: Page, id: string): Promise<TaskDetail> {
  return (await (await apiCall(page, 'GET', `/api/v1/tasks/${id}`)).json()) as TaskDetail;
}

test('AC-3.1 a row click opens the pane, the URL follows ↑/↓, Esc returns focus then closes', async ({
  page,
}) => {
  const { orgId, today } = await setup(page, 'ac.threeone');
  const a = await createTask(page, orgId, { title: 'Alpha', groupId: today });
  const b = await createTask(page, orgId, { title: 'Beta', groupId: today });
  await page.reload();
  await clickRowBody(page, 'Alpha');
  await expect(pane(page)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/o/personal/t/${a.id}$`));
  await expect(page.getByTestId('pane-title')).toHaveValue('Alpha');
  // A click keeps focus in the list: ↓ moves the selection and the pane follows.
  await page.keyboard.press('ArrowDown');
  await expect(page).toHaveURL(new RegExp(`/o/personal/t/${b.id}$`));
  await expect(page.getByTestId('pane-title')).toHaveValue('Beta');
  // O moves focus into the pane's title; Esc returns it to the list; Esc again closes.
  await page.keyboard.press('o');
  await expect(page.getByTestId('pane-title')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(pane(page)).toBeVisible();
  await expect(row(page, 'Beta').locator('[data-focus-target]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(pane(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/o\/personal\/my$/);
  // Deep link: the pane opens over My tasks with the row selected.
  await page.goto(`/o/personal/t/${a.id}`);
  await expect(page.getByTestId('pane-title')).toHaveValue('Alpha');
  await expect(row(page, 'Alpha')).toHaveAttribute('aria-selected', 'true');
  // The title edits in place (Enter commits).
  await page.getByTestId('pane-title').fill('Alpha renamed');
  await page.getByTestId('pane-title').press('Enter');
  await expect(row(page, 'Alpha renamed')).toBeVisible();
  await waitForSync(page);
  expect((await detail(page, a.id)).title).toBe('Alpha renamed');
  // Full screen with Tab+X, back with Esc.
  await page.getByTestId('pane-title').focus();
  await page.keyboard.down('Tab');
  await page.keyboard.press('x');
  await page.keyboard.up('Tab');
  await expect(page.locator('[data-pane-mode="full"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-pane-mode="split"]')).toBeVisible();

  const results = await new AxeBuilder({ page }).include('[data-pane-root]').analyze();
  expect(results.violations).toEqual([]);
});

test('AC-3.2 a rich description survives save, reload and edit with identical Markdown', async ({
  page,
}) => {
  const { orgId, today } = await setup(page, 'ac.threetwo');
  const markdown = [
    '# Plan',
    '',
    '- one',
    '  - nested',
    '',
    '- [ ] check this',
    '- [x] done',
    '',
    '```',
    'const x = 1;',
    '```',
    '',
    'See [the docs](https://example.com/docs).',
  ].join('\n');
  const task = await createTask(page, orgId, {
    title: 'Described',
    groupId: today,
    description: markdown,
  });
  await page.goto(`/o/personal/t/${task.id}`);
  const editor = page.getByTestId('description-field').locator('[contenteditable="true"]');
  await expect(editor.getByRole('heading', { name: 'Plan' })).toBeVisible();
  await expect(editor.getByRole('link', { name: 'the docs' })).toBeVisible();
  // Focus and blur without typing: nothing is saved.
  await editor.click();
  await page.getByTestId('pane-title').click();
  await waitForSync(page);
  expect((await detail(page, task.id)).description).toBe(markdown);
  // Edit the heading; the rest of the Markdown stays byte for byte.
  await editor.getByRole('heading', { name: 'Plan' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' B');
  await page.getByTestId('pane-title').click();
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-status', /saved|saving/);
  await waitForSync(page);
  const saved = (await detail(page, task.id)).description;
  expect(saved).toBe(markdown.replace('# Plan', '# Plan B'));
  await page.reload();
  await expect(
    page.getByTestId('description-field').getByRole('heading', { name: 'Plan B' }),
  ).toBeVisible();
  expect((await detail(page, task.id)).description).toBe(saved);
});

test('AC-3.3 subtasks expand inline, Enter adds a sibling, completing updates the counter', async ({
  page,
}) => {
  const { orgId, today } = await setup(page, 'ac.threethree');
  const parent = await createTask(page, orgId, { title: 'Parent', groupId: today });
  for (const title of ['Sub one', 'Sub two']) {
    await createTask(page, orgId, { title, parentId: parent.id });
  }
  await page.reload();
  await expect(row(page, 'Parent').getByTestId('subtask-counter')).toHaveText(/0\/2/);
  await expect(page.getByText('Sub one')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show subtasks of Parent' }).click();
  const sub = row(page, 'Sub one');
  await expect(sub).toHaveAttribute('aria-level', '3');
  // Enter in a subtask creates a sibling subtask.
  await sub.locator('[data-focus-target]').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Sub between');
  await page.keyboard.press('Escape');
  await expect(row(page, 'Sub between')).toHaveAttribute('aria-level', '3');
  await waitForSync(page);
  const children = (await detail(page, parent.id)).subtasks.map((t) => t.title);
  expect(children).toEqual(['Sub one', 'Sub between', 'Sub two']);
  // Completing a subtask updates "1/3" at once.
  await row(page, 'Sub two').locator('label').first().click();
  await expect(row(page, 'Parent').getByTestId('subtask-counter')).toHaveText(/1\/3/);
  // ← on a subtask selects the parent, ← again collapses it; the state is persisted.
  await row(page, 'Sub one').click({ position: { x: 600, y: 10 } });
  // The click opens the pane; Esc must reach the pane, not race its mount under load.
  await expect(page.locator('[data-pane-root]')).toBeVisible();
  await page.keyboard.press('Escape'); // keep focus in the list, close the pane
  await expect(page.locator('[data-pane-root]')).toHaveCount(0);
  await page.keyboard.press('ArrowLeft');
  await expect(row(page, 'Parent')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(row(page, 'Parent')).toHaveAttribute('aria-expanded', 'false');
  await waitForSync(page);
  expect((await myList(page, orgId)).expandedTaskIds).not.toContain(parent.id);
  // Tab+S adds a subtask (expanding the parent).
  await page.keyboard.down('Tab');
  await page.keyboard.press('s');
  await page.keyboard.up('Tab');
  await page.keyboard.type('Sub last');
  await page.keyboard.press('Escape');
  await waitForSync(page);
  expect((await detail(page, parent.id)).subtasks.at(-1)?.title).toBe('Sub last');
  expect((await myList(page, orgId)).expandedTaskIds).toContain(parent.id);
});

test('AC-3.4 #urgent creates the tag, shows a chip, and the header filter shows only its tasks', async ({
  page,
}) => {
  const { orgId, today } = await setup(page, 'ac.threefour');
  await createTask(page, orgId, { title: 'Untagged task', groupId: today });
  await page.reload();
  await page.getByRole('button', { name: 'Add task' }).nth(1).click();
  await page.keyboard.type('Fix login #urg');
  await expect(page.getByRole('listbox', { name: 'Tag suggestions' })).toBeVisible();
  await page.keyboard.type('ent');
  // Enter takes the suggestion ("Create urgent"), the next Enter commits.
  await page.keyboard.press('Enter');
  await expect(page.locator('input[data-list-input]').first()).toHaveValue('Fix login #urgent ');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  const tagged = row(page, 'Fix login');
  await expect(tagged.locator('[data-tag-chips]')).toContainText('urgent');
  await waitForSync(page);
  const all = await tags(page, orgId);
  expect(all.map((t) => t.name)).toEqual(['urgent']);
  const list = await myList(page, orgId);
  const task = list.tasks.find((t) => t.title === 'Fix login') as Task;
  expect(task.tagIds).toEqual([all[0]?.id]);

  // The header filter keeps group headers and shows only matching rows.
  await page.getByTestId('tag-filter').click();
  await page.getByRole('menuitemcheckbox', { name: 'urgent' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('task-row')).toHaveCount(1);
  await expect(row(page, 'Fix login')).toBeVisible();
  await expect(page.getByRole('row', { name: /Today/ }).first()).toBeVisible();
  await page.getByTestId('tag-filter').click();
  await page.getByRole('menuitem', { name: 'Clear filter' }).click();
  await expect(page.getByTestId('task-row')).toHaveCount(2);

  // The tag picker (T) toggles tags and creates new ones.
  await row(page, 'Untagged task').locator('[data-focus-target]').focus();
  await page.keyboard.press('t');
  await page.keyboard.type('home');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(row(page, 'Untagged task').locator('[data-tag-chips]')).toContainText('home');
  await waitForSync(page);
  expect((await tags(page, orgId)).map((t) => t.name).sort()).toEqual(['home', 'urgent']);
});

test('tag chips in a narrow row drop out whole instead of running under the icons', async ({
  page,
}) => {
  const { orgId, today } = await setup(page, 'tags.narrow');
  const task = await createTask(page, orgId, {
    title: 'Homepage hero concepts for the spring campaign',
    description: 'Three directions.',
    groupId: today,
    tagNames: ['design', 'client'],
  });
  await createTask(page, orgId, { title: 'Collect imagery', parentId: task.id });
  await page.reload();
  await clickRowBody(page, 'Homepage hero');
  await expect(pane(page)).toBeVisible();
  const meta = row(page, 'Homepage hero').locator('[data-row-meta]');
  await expect(meta.getByTestId('subtask-counter')).toBeVisible();
  // Narrower and narrower meta: both chips, one, then none, never a cut one.
  const visible: string[] = [];
  for (const width of [200, 140, 110, 90, 60]) {
    const layout = await meta.evaluate((el, width) => {
      (el as HTMLElement).style.maxWidth = `${width}px`;
      const area = (el.querySelector('[data-tag-chips]') as Element).getBoundingClientRect();
      const icon = el.querySelector('[data-testid="description-indicator"]') as Element;
      const chips = [...el.querySelectorAll('[data-tag-chips] [aria-hidden] > span')]
        .map((chip) => ({ name: chip.textContent ?? '', box: chip.getBoundingClientRect() }))
        .filter(({ box }) => box.width > 0);
      return {
        areaRight: area.right,
        iconLeft: icon.getBoundingClientRect().left,
        chips: chips.map(({ name, box }) => ({
          name,
          shown: box.top >= area.top - 0.5 && box.bottom <= area.bottom + 0.5,
          whole: box.left >= area.left - 0.5 && box.right <= area.right + 0.5,
        })),
      };
    }, width);
    expect(layout.areaRight).toBeLessThanOrEqual(layout.iconLeft);
    for (const chip of layout.chips) {
      if (chip.shown) expect(chip.whole, `${chip.name} at ${width}px`).toBe(true);
    }
    visible.push(
      layout.chips
        .filter((c) => c.shown)
        .map((c) => c.name)
        .join(','),
    );
  }
  // The later chip goes first; the widths depend on the UI scale.
  expect(visible[0]).toBe('design,client');
  expect(visible).toContain('design');
  expect(visible.at(-1)).toBe('');
});

test("picking a day in a row's date picker sets the date without opening the pane", async ({
  page,
}) => {
  const { orgId, today } = await setup(page, 'date.nopane');
  const task = await createTask(page, orgId, { title: 'Book the venue', groupId: today });
  await page.reload();
  await row(page, 'Book the venue').getByRole('button', { name: 'Set due date' }).click();
  const dialog = page.getByRole('dialog', { name: 'Due date' });
  await expect(dialog).toBeVisible();
  // A day in the calendar is not a <button>, and the picker is portalled out of the row.
  await dialog
    .getByRole('grid')
    .getByRole('gridcell', { name: / 20, \d{4}$/ })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    row(page, 'Book the venue').getByRole('button', { name: /^Due date/ }),
  ).toBeVisible();
  await expect(pane(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/o\/personal\/my$/);
  await waitForSync(page);
  expect((await detail(page, task.id)).dueDate).toMatch(/-20$/);
});

test('AC-3.5 cycles and nesting deeper than 5 levels are rejected', async ({ page }) => {
  const { orgId, today } = await setup(page, 'ac.threefive');
  const root = await createTask(page, orgId, { title: 'Level 0', groupId: today });
  const chain = [root];
  for (let level = 1; level <= 5; level++) {
    chain.push(
      await createTask(page, orgId, {
        title: `Level ${level}`,
        parentId: (chain.at(-1) as Task).id,
      }),
    );
  }
  const cycle = await apiCall(page, 'PATCH', `/api/v1/tasks/${root.id}`, {
    parentId: (chain[2] as Task).id,
  });
  expect(cycle.status()).toBe(422);
  expect(((await cycle.json()) as { code: string }).code).toBe('subtask_cycle');
  const deep = await apiCall(page, 'POST', `/api/v1/orgs/${orgId}/tasks`, {
    title: 'Level 6',
    parentId: (chain[5] as Task).id,
  });
  expect(deep.status()).toBe(422);
  expect(((await deep.json()) as { code: string }).code).toBe('subtask_depth');
  // The list explains the limit instead of creating a row the server would reject.
  for (const task of chain.slice(0, 5)) {
    await apiCall(page, 'PUT', `/api/v1/tasks/${task.id}/expanded`);
  }
  await page.reload();
  await row(page, 'Level 5').locator('[data-focus-target]').focus();
  await page.keyboard.press('s');
  await expect(page.getByRole('status').filter({ hasText: 'nested 5 levels' })).toBeVisible();
});

test('Ctrl+D duplicates a task with its subtasks directly after the original', async ({ page }) => {
  const { orgId, today } = await setup(page, 'p3.duplicate');
  const original = await createTask(page, orgId, {
    title: 'Original',
    groupId: today,
    tagNames: ['copyme'],
  });
  await createTask(page, orgId, { title: 'Child', parentId: original.id });
  await createTask(page, orgId, { title: 'After', groupId: today });
  await page.reload();
  await row(page, 'Original').locator('[data-focus-target]').focus();
  await page.keyboard.press(`${mod}+d`);
  await expect(page.getByTestId('task-row').filter({ hasText: 'Original' })).toHaveCount(2);
  await waitForSync(page);
  const list = await myList(page, orgId);
  const top = list.tasks
    .filter((t) => t.placement?.groupId === today && t.completedAt === null)
    .sort((a, b) => ((a.placement?.position ?? '') < (b.placement?.position ?? '') ? -1 : 1))
    .map((t) => t.title);
  expect(top).toEqual(['Original', 'Original', 'After']);
  const copy = list.tasks.find((t) => t.title === 'Original' && t.id !== original.id) as Task;
  expect(copy.tagIds).toEqual(original.tagIds);
  expect(list.tasks.filter((t) => t.parentId === copy.id).map((t) => t.title)).toEqual(['Child']);
  await expect(row(page, 'Original').nth(0)).toBeVisible();
});

test('Settings → Tags renames, recolours, merges and deletes tags', async ({ page }) => {
  const { orgId, today } = await setup(page, 'p3.tagsettings');
  await createTask(page, orgId, { title: 'One', groupId: today, tagNames: ['alpha'] });
  await createTask(page, orgId, { title: 'Two', groupId: today, tagNames: ['beta', 'gamma'] });
  await page.goto('/o/personal/settings#tags');
  const section = page.locator('#tags');
  await expect(section.getByTestId('tag-settings-row')).toHaveCount(3);
  // Rename inline.
  await section.getByRole('button', { name: 'Rename alpha' }).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('alpine');
  await page.keyboard.press('Enter');
  await expect(section.locator('[data-tag="alpine"]')).toBeVisible();
  // Recolour.
  await section.getByRole('button', { name: 'Colour of alpine' }).click();
  await page
    .getByRole('dialog')
    .getByRole('radio', { name: 'Purple' })
    .locator('xpath=ancestor::label')
    .click();
  await page.keyboard.press('Escape');
  await expect
    .poll(async () => (await tags(page, orgId)).find((t) => t.name === 'alpine')?.color)
    .toBe('purple');
  // Merge beta into gamma.
  await section.getByRole('button', { name: 'Options for beta' }).click();
  await page.getByRole('menuitem', { name: 'Merge into…' }).click();
  await page.getByRole('menuitem', { name: 'gamma' }).click();
  await section.getByRole('button', { name: 'Merge tags' }).click();
  await expect(section.getByTestId('tag-settings-row')).toHaveCount(2);
  // Delete with an inline confirmation.
  await section.getByRole('button', { name: 'Options for gamma' }).click();
  await page.getByRole('menuitem', { name: 'Delete gamma' }).click();
  await section.getByRole('button', { name: 'Delete tag' }).click();
  await expect(section.getByTestId('tag-settings-row')).toHaveCount(1);
  expect((await tags(page, orgId)).map((t) => t.name)).toEqual(['alpine']);
  const two = (await myList(page, orgId)).tasks.find((t) => t.title === 'Two') as Task;
  expect(two.tagIds).toEqual([]);

  const results = await new AxeBuilder({ page }).include('#tags').analyze();
  expect(results.violations).toEqual([]);
});

test('a task created with the pane open takes the pane; the empty row below keeps the caret and goes when left (ADR 0064)', async ({
  page,
}) => {
  const { orgId, today } = await setup(page, 'p3.created');
  await createTask(page, orgId, { title: 'Alpha', groupId: today });
  await page.reload();
  await clickRowBody(page, 'Alpha');
  await expect(page.getByTestId('pane-title')).toHaveValue('Alpha');
  await row(page, 'Alpha').locator('[data-focus-target]').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Gamma');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('pane-title')).toHaveValue('Gamma');
  // The caret waits in the new, empty row below Gamma: the pane's selection sync must not
  // end that edit and leave a row that is neither a task nor an input.
  const input = page.locator('[data-list-input]');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('');
  await pane(page).getByTestId('description-field').click();
  await expect(input).toHaveCount(0);
  await expect(page.getByTestId('task-row')).toHaveCount(2);
  await expect(page.getByTestId('task-row').filter({ hasText: /^$/ })).toHaveCount(0);
});
