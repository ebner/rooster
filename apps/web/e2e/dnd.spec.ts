import type { Locator, Page, Request } from '@playwright/test';
import { apiCall, signInAs, uniqueEmail } from './support/auth';
import { clickRowBody, createTask, groupId, personalOrg, waitForSync } from './support/p3';
import { expect, test } from './support/test';

/**
 * 02 §5 drag and drop: the preview follows the pointer at the grab offset wherever the list
 * sits (scrolled, sidebar collapsed, pane open, tablet), the drop line is where the drop lands,
 * and places equivalent to the dragged item's own position are never offered or sent.
 */

const shots = process.env.ROOSTER_DND_SCREENSHOTS;
/** Sub-pixel layout and the one move between activation and the first frame. */
const tolerance = 2;

test.use({ viewport: { width: 1440, height: 900 } });

async function setup(page: Page, name: string, count: number) {
  await signInAs(page, uniqueEmail(name));
  const orgId = await personalOrg(page);
  const today = await groupId(page, orgId, 'Today');
  let afterId: string | null = null;
  const ids: string[] = [];
  for (let i = 1; i <= count; i++) {
    const task = await createTask(page, orgId, {
      title: `Task ${i}`,
      groupId: today,
      afterId,
      beforeId: null,
    });
    ids.push(task.id);
    afterId = task.id;
  }
  await page.reload();
  await expect(page.getByRole('treegrid')).toBeVisible();
  if (count > 0) await expect(row(page, `Task ${count}`)).toBeVisible();
  return { orgId, ids };
}

const row = (page: Page, title: string) =>
  page.getByTestId('task-row').filter({ has: page.getByText(title, { exact: true }) });

const header = (page: Page, name: string) =>
  page
    .getByTestId('group-header')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error('not visible');
  return b;
}

/** A row-relative point on the row body just past the title text (a press there drags). */
async function pastTitle(page: Page, title: string) {
  const r = await box(row(page, title));
  const text = await box(row(page, title).getByText(title, { exact: true }));
  return { x: text.x + text.width + 24 - r.x, y: r.height / 2 };
}

/** Presses on `locator` at `at` (row-relative) and moves past the 4 px threshold. */
async function lift(page: Page, locator: Locator, at: { x: number; y: number }) {
  const b = await box(locator);
  const grab = { x: b.x + at.x, y: b.y + at.y };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x, grab.y + 10, { steps: 4 });
  return { grab, offset: at };
}

/** The preview's untilted box (its layer) and the drop line's centre, if any. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const layer = document.querySelector('[data-testid=drag-layer]')?.getBoundingClientRect();
    const line = document.querySelector('[data-testid=drop-indicator]')?.getBoundingClientRect();
    return {
      layer: layer ? { x: layer.x, y: layer.y, width: layer.width, height: layer.height } : null,
      line: line ? line.y + line.height / 2 : null,
    };
  });
}

/** The scroll container of the list. */
async function scrollList(page: Page, top: number) {
  return page.evaluate((top) => {
    let node = document.querySelector('[data-list-root]')?.parentElement ?? null;
    while (node && !['auto', 'scroll'].includes(getComputedStyle(node).overflowY)) {
      node = node.parentElement;
    }
    if (!node) throw new Error('no scroller');
    if (top >= 0) node.scrollTop = top;
    return node.scrollTop;
  }, top);
}

/**
 * Drags `from` (grabbed 300 px in, mid-height) over the lower half of `to` and checks that
 * the grab point stays under the pointer and the line sits at the bottom of `to`.
 */
async function expectPreviewUnderPointer(page: Page, from: string, to: string, shot: string) {
  const source = await box(row(page, from));
  const { offset } = await lift(page, row(page, from), { x: 300, y: source.height / 2 });
  const target = await box(row(page, to));
  const pointer = { x: target.x + 340, y: target.y + target.height * 0.75 };
  await page.mouse.move(pointer.x, pointer.y, { steps: 8 });
  await expect(page.getByTestId('drop-indicator')).toBeVisible();
  const { layer, line } = await measure(page);
  if (!layer || line === null) throw new Error('no preview or line');
  expect(Math.abs(layer.x - (pointer.x - offset.x))).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(layer.y - (pointer.y - offset.y))).toBeLessThanOrEqual(tolerance);
  // The width and height of the original row (02 §5).
  expect(Math.abs(layer.width - source.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(layer.height - source.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(line - (target.y + target.height))).toBeLessThanOrEqual(tolerance);
  if (shots) await page.screenshot({ path: `${shots}/${shot}.png` });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.getByTestId('drag-layer')).toHaveCount(0);
}

/** Every mutating API request the page makes from now on. */
function writes(page: Page): Request[] {
  const seen: Request[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && request.url().includes('/api/v1/')) seen.push(request);
  });
  return seen;
}

test('the drag preview tracks the pointer at the grab offset: scrolled, sidebar, pane', async ({
  page,
}) => {
  const { ids } = await setup(page, 'dnd.track', 40);
  await expectPreviewUnderPointer(page, 'Task 3', 'Task 8', 'desktop');

  await scrollList(page, 600);
  await expectPreviewUnderPointer(page, 'Task 22', 'Task 26', 'desktop-scrolled');

  await scrollList(page, 0);
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expectPreviewUnderPointer(page, 'Task 4', 'Task 9', 'desktop-sidebar-collapsed');

  await clickRowBody(page, 'Task 2');
  await expect(page).toHaveURL(new RegExp(`/t/${ids[1]}$`));
  await expect(page.getByTestId('detail-pane')).toBeVisible();
  await page.mouse.move(10, 450);
  await expectPreviewUnderPointer(page, 'Task 5', 'Task 10', 'desktop-pane-open');
});

test('the drop line stays under the pointer while the list auto-scrolls', async ({ page }) => {
  await setup(page, 'dnd.autoscroll', 60);
  const { offset } = await lift(page, row(page, 'Task 4'), { x: 300, y: 20 });
  // The bottom auto-scroll zone (64 px).
  await page.mouse.move(700, 890, { steps: 6 });
  await expect.poll(() => scrollList(page, -1)).toBeGreaterThan(400);
  await page.mouse.move(700, 450, { steps: 6 });
  const scrolled = await scrollList(page, -1);
  await page.waitForTimeout(100);
  expect(await scrollList(page, -1)).toBe(scrolled);
  const { layer, line } = await measure(page);
  if (!layer || line === null) throw new Error('no preview or line');
  expect(Math.abs(layer.y - (450 - offset.y))).toBeLessThanOrEqual(tolerance);
  // The line is at the nearer edge of the row under the pointer: at most half a row away.
  expect(Math.abs(line - 450)).toBeLessThanOrEqual(20 + tolerance);
  await page.keyboard.press('Escape');
  await page.mouse.up();
});

test.describe('tablet', () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test('the drag preview tracks the pointer on a tablet', async ({ page }) => {
    await setup(page, 'dnd.tablet', 20);
    await expectPreviewUnderPointer(page, 'Task 2', 'Task 6', 'tablet');
    await scrollList(page, 200);
    await expectPreviewUnderPointer(page, 'Task 8', 'Task 12', 'tablet-scrolled');
  });
});

test('a task is never offered directly before or after itself (pointer, selection, keyboard)', async ({
  page,
}) => {
  await setup(page, 'dnd.self', 6);
  const sent = writes(page);
  const live = page.getByTestId('list-live');

  // Pointer: the gaps above and below Task 3 are its own place.
  const three = await box(row(page, 'Task 3'));
  await lift(page, row(page, 'Task 3'), { x: 300, y: three.height / 2 });
  const two = await box(row(page, 'Task 2'));
  const four = await box(row(page, 'Task 4'));
  await page.mouse.move(700, two.y + two.height * 0.75, { steps: 4 });
  await expect(page.getByTestId('drop-indicator')).toHaveCount(0);
  await page.mouse.move(700, four.y + four.height * 0.25, { steps: 4 });
  await expect(page.getByTestId('drop-indicator')).toHaveCount(0);
  // A real move nearby is offered.
  await page.mouse.move(700, two.y + two.height * 0.25, { steps: 4 });
  await expect(page.getByTestId('drop-indicator')).toBeVisible();
  // Back to its own place, and dropped there: nothing is sent.
  await page.mouse.move(700, four.y + four.height * 0.25, { steps: 4 });
  await expect(page.getByTestId('drop-indicator')).toHaveCount(0);
  await page.mouse.up();
  await expect(live).toContainText('Drop cancelled.');

  // A contiguous selection (Task 3 and 4) is not offered its own place either.
  await clickRowBody(page, 'Task 3');
  // A row click opens the detail pane (split): the list re-lays out while it slides in, so
  // wait until the pane is there and the row has stopped moving before extending the range.
  await expect(page.locator('[data-pane-root]')).toBeVisible();
  await expect
    .poll(async () => {
      const a = await row(page, 'Task 4').boundingBox();
      await page.waitForTimeout(100);
      const b = await row(page, 'Task 4').boundingBox();
      return a && b && a.x === b.x && a.y === b.y && a.width === b.width;
    })
    .toBe(true);
  await row(page, 'Task 4').click({ modifiers: ['Shift'], position: { x: 200, y: 20 } });
  await expect(row(page, 'Task 4')).toHaveAttribute('aria-selected', 'true');
  await lift(page, row(page, 'Task 3'), await pastTitle(page, 'Task 3'));
  await expect(page.getByTestId('drop-indicator')).toHaveCount(0);
  const [b2, b5] = [await box(row(page, 'Task 2')), await box(row(page, 'Task 5'))];
  const x = b2.x + 150;
  await page.mouse.move(x, b2.y + b2.height * 0.75, { steps: 4 });
  await expect(page.getByTestId('drop-indicator')).toHaveCount(0);
  await page.mouse.move(x, b5.y + b5.height * 0.25, { steps: 4 });
  await expect(page.getByTestId('drop-indicator')).toHaveCount(0);
  await page.mouse.move(x, b5.y + b5.height * 0.75, { steps: 4 });
  await expect(page.getByTestId('drop-indicator')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(live).toContainText('Drop cancelled.');
  await page.reload();
  await expect(row(page, 'Task 6')).toBeVisible();

  // Keyboard drag: the lift position has no line, and dropping there changes nothing.
  await page.getByRole('button', { name: 'Move Task 3' }).focus();
  await page.keyboard.press('Space');
  await expect(live).toContainText('Picked up Task 3. Position 3 of 6 in Today.');
  await expect(page.getByTestId('drop-indicator')).toHaveCount(0);
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('drop-indicator')).toBeVisible();
  await page.keyboard.press('ArrowUp');
  await expect(live).toContainText('Task 3 is at position 3 of 6 in Today.');
  await expect(page.getByTestId('drop-indicator')).toHaveCount(0);
  await page.keyboard.press('Space');
  await expect(live).toContainText('Drop cancelled.');

  // No undo step was recorded: Ctrl+Z has nothing to undo.
  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForTimeout(300);
  await waitForSync(page);
  expect(sent.map((r) => `${r.method()} ${new URL(r.url()).pathname}`)).toEqual([]);
  await expect(page.getByTestId('task-row')).toHaveText(
    ['Task 1', 'Task 2', 'Task 3', 'Task 4', 'Task 5', 'Task 6'].map((t) => new RegExp(t)),
  );
});

test('a group is never offered directly before or after itself', async ({ page }) => {
  await setup(page, 'dnd.groupself', 0);
  const names = await page.getByTestId('group-header').getByRole('heading').allTextContents();
  expect(names.length).toBeGreaterThanOrEqual(3);
  const [first, middle, last] = names as [string, string, string];
  const sent = writes(page);

  const source = await box(header(page, middle));
  await lift(page, header(page, middle), { x: 200, y: source.height / 2 });
  // All groups collapse during a group drag; measure them afterwards.
  const above = await box(header(page, first));
  const self = await box(header(page, middle));
  const below = await box(header(page, last));
  await page.mouse.move(700, above.y + above.height * 0.75, { steps: 4 });
  await expect(page.getByTestId('drop-indicator')).toHaveCount(0);
  await page.mouse.move(700, self.y + self.height * 0.25, { steps: 4 });
  await expect(page.getByTestId('drop-indicator')).toHaveCount(0);
  await page.mouse.move(700, below.y + below.height * 0.25, { steps: 4 });
  await expect(page.getByTestId('drop-indicator')).toHaveCount(0);
  await page.mouse.move(700, above.y + above.height * 0.25, { steps: 4 });
  await expect(page.getByTestId('drop-indicator')).toBeVisible();
  await page.mouse.move(700, below.y + below.height * 0.25, { steps: 4 });
  await expect(page.getByTestId('drop-indicator')).toHaveCount(0);
  await page.mouse.up();
  await expect(page.getByTestId('list-live')).toContainText('Drop cancelled.');
  await page.waitForTimeout(300);
  expect(sent.map((r) => `${r.method()} ${new URL(r.url()).pathname}`)).toEqual([]);
  await expect(page.getByTestId('group-header').getByRole('heading')).toHaveText(names);

  // A real move still works.
  const target = await box(header(page, last));
  await lift(page, header(page, first), { x: 200, y: target.height / 2 });
  const end = await box(header(page, last));
  await page.mouse.move(700, end.y + end.height * 0.75, { steps: 6 });
  await expect(page.getByTestId('drop-indicator')).toBeVisible();
  await page.mouse.up();
  await expect(page.getByTestId('group-header').getByRole('heading')).toHaveText([
    middle,
    last,
    first,
  ]);
});

test('subtasks reorder among their siblings and are never offered their own place', async ({
  page,
}) => {
  const { orgId } = await setup(page, 'dnd.subtasks', 0);
  const today = await groupId(page, orgId, 'Today');
  const parent = await createTask(page, orgId, { title: 'Parent', groupId: today });
  for (const title of ['Sub 1', 'Sub 2', 'Sub 3']) {
    await createTask(page, orgId, { title, parentId: parent.id });
  }
  await page.reload();
  await page.getByRole('button', { name: 'Show subtasks of Parent' }).click();
  await expect(row(page, 'Sub 3')).toBeVisible();
  const sent = writes(page);

  const [s1, s2, s3] = [
    await box(row(page, 'Sub 1')),
    await box(row(page, 'Sub 2')),
    await box(row(page, 'Sub 3')),
  ];
  const x = s2.x + 200;
  await lift(page, row(page, 'Sub 2'), { x: 200, y: s2.height / 2 });
  await page.mouse.move(x, s1.y + s1.height * 0.75, { steps: 4 });
  await expect(page.getByTestId('drop-indicator')).toHaveCount(0);
  await page.mouse.move(x, s3.y + s3.height * 0.25, { steps: 4 });
  await expect(page.getByTestId('drop-indicator')).toHaveCount(0);
  await page.mouse.up();
  await expect(page.getByTestId('list-live')).toContainText('Drop cancelled.');
  await page.waitForTimeout(300);
  expect(sent).toEqual([]);

  // Below Sub 3: a real reorder.
  await lift(page, row(page, 'Sub 2'), { x: 200, y: s2.height / 2 });
  await page.mouse.move(x, s3.y + s3.height * 0.75, { steps: 6 });
  await expect(page.getByTestId('drop-indicator')).toBeVisible();
  await page.mouse.up();
  await waitForSync(page);
  const detail = await apiCall(page, 'GET', `/api/v1/tasks/${parent.id}`);
  const subtasks = ((await detail.json()) as { subtasks: { title: string }[] }).subtasks;
  expect(subtasks.map((t) => t.title)).toEqual(['Sub 1', 'Sub 3', 'Sub 2']);
});
