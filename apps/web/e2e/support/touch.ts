import type { Locator, Page } from '@playwright/test';

/**
 * Touch gestures for the phone projects. Playwright's touchscreen only taps, so swipes and
 * long-presses are dispatched as real DOM events: pointer events (pointerType "touch") for
 * the swipe handler, and TouchEvents for dnd-kit's long-press TouchSensor.
 */

async function centre(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('element not visible');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

/** A horizontal swipe across `locator`, `share` of its width (negative: to the left). */
export async function swipe(page: Page, locator: Locator, share: number, steps = 10) {
  const { y, box } = await centre(locator);
  const startX = share > 0 ? box.x + box.width * 0.1 : box.x + box.width * 0.9;
  const dx = box.width * share;
  await page.evaluate(
    async ({ startX, y, dx, steps }) => {
      const target = document.elementFromPoint(startX, y);
      if (!target) throw new Error('nothing under the finger');
      const fire = (type: string, x: number) =>
        target.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            pointerId: 7,
            pointerType: 'touch',
            isPrimary: true,
            button: type === 'pointermove' ? -1 : 0,
            buttons: type === 'pointerup' ? 0 : 1,
            clientX: x,
            clientY: y,
          }),
        );
      fire('pointerdown', startX);
      for (let i = 1; i <= steps; i += 1) {
        await new Promise((r) => setTimeout(r, 16));
        fire('pointermove', startX + (dx * i) / steps);
      }
      fire('pointerup', startX + dx);
    },
    { startX, y, dx, steps },
  );
}

/** Dispatches one TouchEvent at (x, y) on `target` (dnd-kit listens on the touched element). */
async function touch(
  page: Page,
  type: 'touchstart' | 'touchmove' | 'touchend',
  x: number,
  y: number,
  start: { x: number; y: number },
) {
  await page.evaluate(
    ({ type, x, y, start }) => {
      const w = window as unknown as { __touchTarget?: Element | undefined };
      if (type === 'touchstart')
        w.__touchTarget = document.elementFromPoint(start.x, start.y) ?? undefined;
      const target = w.__touchTarget;
      if (!target) throw new Error('nothing under the finger');
      // WebKit has no Touch constructor: a plain event carrying the fields dnd-kit and React
      // read (touches, clientX/Y) stands in for a TouchEvent.
      const point = { identifier: 3, target, clientX: x, clientY: y, pageX: x, pageY: y };
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
    { type, x, y, start },
  );
}

/** Long-press (past dnd-kit's 350 ms) and, optionally, drag to `to` before releasing. */
export async function longPress(
  page: Page,
  locator: Locator,
  to?: { x: number; y: number },
  holdMs = 500,
) {
  const { x, y } = await centre(locator);
  const start = { x: x - 40, y };
  await touch(page, 'touchstart', start.x, start.y, start);
  await page.waitForTimeout(holdMs);
  if (to) {
    const steps = 12;
    for (let i = 1; i <= steps; i += 1) {
      await touch(
        page,
        'touchmove',
        start.x + ((to.x - start.x) * i) / steps,
        start.y + ((to.y - start.y) * i) / steps,
        start,
      );
      await page.waitForTimeout(20);
    }
    await touch(page, 'touchend', to.x, to.y, start);
  } else {
    await touch(page, 'touchend', start.x, start.y, start);
  }
}

/**
 * Emulates the on-screen keyboard: the visual viewport shrinks by `height` px from the
 * bottom, as iOS and Android report it, and a resize is dispatched.
 */
export async function showKeyboard(page: Page, height: number) {
  await page.evaluate((height) => {
    const vv = window.visualViewport;
    if (!vv) throw new Error('no visualViewport');
    const full = window.innerHeight;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => full - height });
    Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => 0 });
    vv.dispatchEvent(new Event('resize'));
  }, height);
}
