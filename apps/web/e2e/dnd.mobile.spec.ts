import type { Locator, Page, Request } from '@playwright/test';
import { signInAs, uniqueEmail } from './support/auth';
import { createTask, groupId, myList, personalOrg, waitForSync } from './support/p3';
import { expect, test } from './support/test';

/**
 * 02 §5 / §13.2 on phones: a long-press drag shows the preview under the finger at the grab
 * offset (no tilt on touch), and the dragged task's own place is never a drop target.
 */

const shots = process.env.ROOSTER_DND_SCREENSHOTS;
const tolerance = 2;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      sessionStorage.setItem('e2e-init', '1');
      localStorage.setItem('rooster.locale', 'en');
    }
  });
});

async function setup(page: Page, name: string, count: number) {
  // Both phone projects start workers in the same millisecond: keep their users apart.
  const project = test.info().project.name.replaceAll('-', '.');
  await signInAs(page, uniqueEmail(`${name}.${project}`));
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
  // WebKit sometimes reports the first reload as interrupted (a dev-server module reload).
  await page.reload().catch(() => page.goto('/o/personal/my'));
  await expect(row(page, `Task ${count}`)).toBeVisible({ timeout: 15_000 });
  return { orgId, today, ids };
}

const row = (page: Page, title: string) =>
  page.getByTestId('task-row').filter({ has: page.getByText(title, { exact: true }) });

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error('not visible');
  return b;
}

/**
 * One touch event at (x, y) on the element first touched. WebKit has no Touch constructor, so
 * a plain event carries the fields dnd-kit and React read (as in support/touch.ts).
 */
async function touch(
  page: Page,
  type: 'touchstart' | 'touchmove' | 'touchend',
  x: number,
  y: number,
) {
  await page.evaluate(
    ({ type, x, y }) => {
      const w = window as unknown as { __dndTarget?: Element | undefined };
      if (type === 'touchstart') w.__dndTarget = document.elementFromPoint(x, y) ?? undefined;
      const target = w.__dndTarget;
      if (!target) throw new Error('nothing under the finger');
      const point = { identifier: 5, target, clientX: x, clientY: y, pageX: x, pageY: y };
      const active = type === 'touchend' ? [] : [point];
      const event = new Event(type, { bubbles: true, cancelable: true, composed: true });
      Object.defineProperties(event, {
        touches: { value: active },
        targetTouches: { value: active },
        changedTouches: { value: [point] },
        clientX: { value: x },
        clientY: { value: y },
      });
      target.dispatchEvent(event);
    },
    { type, x, y },
  );
}

/** Long-presses `locator` at `at` (row-relative), then moves the finger to `to`. */
async function longPressDrag(
  page: Page,
  locator: Locator,
  at: { x: number; y: number },
  to: { x: number; y: number },
) {
  const b = await box(locator);
  const start = { x: b.x + at.x, y: b.y + at.y };
  await touch(page, 'touchstart', start.x, start.y);
  await page.waitForTimeout(500);
  const steps = 10;
  for (let i = 1; i <= steps; i += 1) {
    await touch(
      page,
      'touchmove',
      start.x + ((to.x - start.x) * i) / steps,
      start.y + ((to.y - start.y) * i) / steps,
    );
    await page.waitForTimeout(20);
  }
}

function writes(page: Page): Request[] {
  const seen: Request[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && request.url().includes('/api/v1/')) seen.push(request);
  });
  return seen;
}

test('the long-press preview sits under the finger at the grab offset, untilted', async ({
  page,
}) => {
  const { orgId, today, ids } = await setup(page, 'dnd.phone', 8);
  const source = await box(row(page, 'Task 2'));
  const target = await box(row(page, 'Task 5'));
  const at = { x: source.width / 2, y: source.height / 2 };
  const to = { x: target.x + target.width / 2 + 20, y: target.y + target.height * 0.75 };
  await longPressDrag(page, row(page, 'Task 2'), at, to);
  await expect(page.getByTestId('drop-indicator')).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/phone.png` });
  const measured = await page.evaluate(() => {
    const layer = document.querySelector('[data-testid=drag-layer]')?.getBoundingClientRect();
    const preview = document.querySelector('[data-testid=drag-preview]');
    const line = document.querySelector('[data-testid=drop-indicator]')?.getBoundingClientRect();
    return {
      layer: layer && { x: layer.x, y: layer.y, width: layer.width, height: layer.height },
      rotate: preview ? getComputedStyle(preview).rotate : null,
      line: line ? line.y + line.height / 2 : null,
    };
  });
  if (!measured.layer || measured.line === null) throw new Error('no preview or line');
  expect(Math.abs(measured.layer.x - (to.x - at.x))).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(measured.layer.y - (to.y - at.y))).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(measured.layer.width - source.width)).toBeLessThanOrEqual(1);
  // 02 §5: the tilt is for pointer drags only.
  expect(measured.rotate ?? 'none').toBe('none');
  expect(Math.abs(measured.line - (target.y + target.height))).toBeLessThanOrEqual(tolerance);
  await touch(page, 'touchend', to.x, to.y);
  await expect
    .poll(async () => {
      const list = await myList(page, orgId);
      return list.tasks
        .filter((t) => t.placement?.groupId === today)
        .sort((a, b) => ((a.placement?.position ?? '') < (b.placement?.position ?? '') ? -1 : 1))
        .map((t) => t.id);
    })
    .toEqual([ids[0], ids[2], ids[3], ids[4], ids[1], ...ids.slice(5)]);
});

test('a long-press drag never offers the task its own place', async ({ page }) => {
  await setup(page, 'dnd.phoneself', 4);
  const sent = writes(page);
  const one = await box(row(page, 'Task 1'));
  const three = await box(row(page, 'Task 3'));
  const x = one.x + one.width / 2;
  // Task 2 over the lower half of Task 1, then the upper half of Task 3: its own place.
  await longPressDrag(
    page,
    row(page, 'Task 2'),
    { x: one.width / 2, y: one.height / 2 },
    {
      x,
      y: one.y + one.height * 0.75,
    },
  );
  await expect(page.getByTestId('drag-layer')).toBeVisible();
  await expect(page.getByTestId('drop-indicator')).toHaveCount(0);
  const from = one.y + one.height * 0.75;
  const end = three.y + three.height * 0.25;
  for (let i = 1; i <= 6; i += 1) await touch(page, 'touchmove', x, from + ((end - from) * i) / 6);
  await expect(page.getByTestId('drop-indicator')).toHaveCount(0);
  await touch(page, 'touchend', x, three.y + three.height * 0.25);
  await expect(page.getByTestId('list-live')).toContainText('Drop cancelled.');
  // Moved past the slop: not selection mode either.
  await expect(page.getByTestId('selection-header')).toHaveCount(0);
  await page.waitForTimeout(300);
  await waitForSync(page);
  expect(sent.map((r) => `${r.method()} ${new URL(r.url()).pathname}`)).toEqual([]);
});
