import type { CDPSession, Page } from '@playwright/test';
import { signInAs, uniqueEmail } from './auth';
import { createTask, groupId, personalOrg } from './p3';
import { expect } from './test';

/**
 * The phone frame's fixed chrome (02 §13.1): measurements and real scroll input for the
 * "the bottom nav and the header never move" specs.
 */

export async function seedLongList(page: Page, name: string, count = 40) {
  await signInAs(page, uniqueEmail(name));
  const orgId = await personalOrg(page);
  const today = await groupId(page, orgId, 'Today');
  let afterId: string | null = null;
  for (let i = 1; i <= count; i++) {
    const task = await createTask(page, orgId, {
      title: `Task ${i}`,
      groupId: today,
      afterId,
      beforeId: null,
    });
    afterId = task.id;
  }
  await page.reload().catch(() => page.goto('/o/personal/my'));
  await expect(page.getByText(`Task ${count}`, { exact: true })).toBeAttached({
    timeout: 15_000,
  });
}

export interface FrameState {
  innerHeight: number;
  /** `document.scrollingElement`: the document must never be scrollable in the phone frame. */
  docScrollHeight: number;
  docScrollTop: number;
  nav: { top: number; bottom: number; height: number } | null;
  headerTop: number | null;
  listScrollTop: number;
  listScrollMax: number;
}

export function frameState(page: Page): Promise<FrameState> {
  return page.evaluate(() => {
    const doc = document.scrollingElement as HTMLElement;
    const nav = document.querySelector('nav[aria-label="Primary"]')?.getBoundingClientRect();
    const header = document.querySelector('[data-testid="mobile-header"]');
    const list = document.querySelector<HTMLElement>('[data-list-column]');
    return {
      innerHeight: window.innerHeight,
      docScrollHeight: doc.scrollHeight,
      docScrollTop: doc.scrollTop,
      nav: nav ? { top: nav.top, bottom: nav.bottom, height: nav.height } : null,
      headerTop: header ? header.getBoundingClientRect().top : null,
      listScrollTop: list?.scrollTop ?? 0,
      listScrollMax: list ? list.scrollHeight - list.clientHeight : 0,
    };
  });
}

/** The nav flush with the viewport bottom, the header at the top, the document unscrolled. */
export async function expectChromeInPlace(page: Page, step: string) {
  const state = await frameState(page);
  expect(state.nav, `${step}: nav visible`).not.toBeNull();
  expect(
    Math.abs((state.nav?.bottom ?? 0) - state.innerHeight),
    `${step}: nav bottom`,
  ).toBeLessThan(1);
  expect(Math.round(state.nav?.height ?? 0), `${step}: nav height`).toBeGreaterThanOrEqual(64);
  expect(state.headerTop, `${step}: header top`).toBe(0);
  expect(state.docScrollTop, `${step}: document scroll`).toBe(0);
  return state;
}

/**
 * A real touch drag through the browser's input pipeline (Chromium only): it scrolls natively,
 * chains and overscrolls like a finger. Fast enough that no long-press starts.
 */
export async function touchDrag(cdp: CDPSession, x: number, fromY: number, toY: number) {
  const steps = 12;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y: fromY, id: 1 }],
  });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: fromY + ((toY - fromY) * i) / steps, id: 1 }],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/**
 * Pulls the list down by `distance` px from (x, y) and releases (pull to refresh). One
 * in-page sequence, so a slow test machine cannot hold the finger still past the 350 ms
 * long-press (which would start a drag instead). WebKit has no Touch constructor: plain events
 * carry the fields the listeners read. dnd-kit reads clientX/Y off a non-TouchEvent: without
 * them it never sees the finger move, and a pull slower than 350 ms becomes a drag.
 */
export async function pullDown(page: Page, x: number, y: number, distance: number) {
  await page.evaluate(
    async ({ x, y, distance }) => {
      const target = document.elementFromPoint(x, y);
      if (!target) throw new Error('nothing under the finger');
      const fire = (type: string, clientY: number) => {
        const point = { identifier: 9, target, clientX: x, clientY, pageX: x, pageY: clientY };
        const active = type === 'touchend' ? [] : [point];
        const event = new Event(type, { bubbles: true, cancelable: true, composed: true });
        Object.defineProperties(event, {
          touches: { value: active },
          targetTouches: { value: active },
          changedTouches: { value: [point] },
          clientX: { value: x },
          clientY: { value: clientY },
        });
        target.dispatchEvent(event);
      };
      fire('touchstart', y);
      for (let i = 1; i <= 10; i++) {
        await new Promise((r) => setTimeout(r, 16));
        fire('touchmove', y + (distance * i) / 10);
      }
      fire('touchend', y + distance);
    },
    { x, y, distance },
  );
}
