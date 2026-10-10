import type { Page } from '@playwright/test';
import { capturing, expect, shot, test } from './shoot';

/** Phone (iPhone 15, WebKit, touch): the phone frame, sheets and gestures. */

const HERO = 'Homepage hero concepts';
const row = (page: Page, title: string) =>
  page.getByTestId('task-row').filter({ hasText: title }).first();

async function reset(page: Page, path: string) {
  await page.goto(path);
  await page.getByTestId('task-row').first().waitFor();
}

/** A swipe that stops halfway, held for the picture, then let go where it started (no action). */
async function holdSwipe(page: Page, title: string, share: number, during: () => Promise<void>) {
  const box = await row(page, title).boundingBox();
  if (!box) throw new Error(`no row ${title}`);
  const y = box.y + box.height / 2;
  const startX = box.x + box.width * 0.15;
  const fire = (type: string, x: number) =>
    page.evaluate(
      ({ type, x, y, startX }) => {
        const target = document.elementFromPoint(startX, y);
        target?.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            pointerId: 9,
            pointerType: 'touch',
            isPrimary: true,
            button: type === 'pointermove' ? -1 : 0,
            buttons: type === 'pointerup' ? 0 : 1,
            clientX: x,
            clientY: y,
          }),
        );
      },
      { type, x, y, startX },
    );
  await fire('pointerdown', startX);
  for (let i = 1; i <= 8; i += 1) {
    await fire('pointermove', startX + (box.width * share * i) / 8);
    await page.waitForTimeout(16);
  }
  await during();
  for (let i = 7; i >= 0; i -= 1) {
    await fire('pointermove', startX + (box.width * share * i) / 8);
    await page.waitForTimeout(16);
  }
  await fire('pointerup', startX);
}

test('phone screens', async ({ page, demo }, testInfo) => {
  test.setTimeout(600_000);
  const run = capturing(testInfo);
  const org = `/o/${demo.orgs.studioSlug}`;

  await run.take('my-tasks', async () => {
    await reset(page, `${org}/my`);
    await shot(page, testInfo, 'my-tasks');
  });

  await run.take('swipe', async () => {
    await reset(page, `${org}/my`);
    await holdSwipe(page, 'Send invoices for September', 0.4, () => shot(page, testInfo, 'swipe'));
  });

  await run.take('date-picker', async () => {
    await reset(page, `${org}/my`);
    await row(page, 'Send invoices for September')
      .getByRole('button', { name: /^Due date/ })
      .click();
    await expect(page.getByTestId('quick-date-sheet')).toBeVisible();
    await shot(page, testInfo, 'date-picker');
  });

  await run.take('org-switcher', async () => {
    await reset(page, `${org}/my`);
    await page.getByTestId('org-switcher').first().click();
    await expect(page.getByRole('dialog').first()).toBeVisible();
    await shot(page, testInfo, 'org-switcher');
  });

  await run.take('task-pane', async () => {
    await reset(page, `${org}/my`);
    await row(page, HERO).locator('[data-focus-target]').click();
    await expect(page.getByTestId('pane-title')).toHaveValue(HERO);
    await shot(page, testInfo, 'task-pane');
  });

  for (const [name, path] of [
    ['today', `${org}/today`],
    ['everyone', `${org}/everyone`],
  ] as const) {
    await run.take(name, async () => {
      await reset(page, path);
      await shot(page, testInfo, name);
    });
  }

  await run.take('inbox', async () => {
    await page.goto('/inbox');
    await expect(page.getByTestId('inbox')).toBeVisible();
    await shot(page, testInfo, 'inbox');
  });

  run.done();
});
