import type { Page } from '@playwright/test';
import {
  expectChromeInPlace,
  frameState,
  pullDown,
  seedLongList,
  touchDrag,
} from './support/phone-frame';
import { expect, test } from './support/test';

/**
 * 02 §13.1 on phones: the bottom nav is fixed at the bottom and the header at the top, like a
 * native tab bar. Only the list scrolls; the document never does, so scrolling past either end
 * of the list, a gesture on the chrome itself, content outside the frame or a pull to refresh
 * can never move (or overscroll) them.
 */

const shots = process.env.ROOSTER_NAV_SCREENSHOTS;
const chromium = () => test.info().project.name === 'mobile-android';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      sessionStorage.setItem('e2e-init', '1');
      localStorage.setItem('rooster.locale', 'en');
    }
  });
});

const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}-${test.info().project.name}.png` });
};

test('the bottom nav and the header stay put while the list scrolls, past both ends', async ({
  page,
}) => {
  await seedLongList(page, 'frame.scroll');
  const before = await expectChromeInPlace(page, 'initial');
  expect(before.docScrollHeight).toBeLessThanOrEqual(before.innerHeight);
  expect(before.listScrollMax).toBeGreaterThan(1000);

  // Scroll chaining stops at the list, and neither the root nor the list overscrolls (no
  // stretch or bounce under the sticky header, no native pull to refresh): ours handles the top.
  const overscroll = await page.evaluate(() => ({
    root: getComputedStyle(document.documentElement).overscrollBehaviorY,
    body: getComputedStyle(document.body).overscrollBehaviorY,
    list: getComputedStyle(document.querySelector('[data-list-column]') as Element)
      .overscrollBehaviorY,
  }));
  expect(overscroll).toEqual({ root: 'none', body: 'none', list: 'none' });

  const x = 200;
  const mid = Math.round(before.innerHeight / 2);
  if (chromium()) {
    const cdp = await page.context().newCDPSession(page);
    // Down to the end and well past it, then back up past the top.
    for (let i = 0; i < 6; i++) await touchDrag(cdp, x, mid + 200, mid - 250);
    await page.waitForTimeout(400);
    let state = await expectChromeInPlace(page, 'touch past the end');
    expect(state.listScrollTop).toBeGreaterThan(0);
    await shot(page, 'scrolled-end');
    for (let i = 0; i < 6; i++) await touchDrag(cdp, x, mid - 250, mid + 200);
    await page.waitForTimeout(400);
    state = await expectChromeInPlace(page, 'touch past the top');
    expect(state.listScrollTop).toBe(0);
    // Gestures that start on the chrome itself go to the document, which cannot scroll.
    const navY = Math.round((state.nav?.top ?? 0) + 20);
    await touchDrag(cdp, x, navY, navY - 300);
    await touchDrag(cdp, x, 20, 400);
    await page.waitForTimeout(400);
    await expectChromeInPlace(page, 'touch on the chrome');

    // The wheel (WebKit's mobile emulation has none).
    await page.mouse.move(x, mid);
    await page.mouse.wheel(0, 20_000);
    await page.waitForTimeout(300);
    state = await expectChromeInPlace(page, 'wheel past the end');
    expect(state.listScrollTop).toBeGreaterThan(0);
    await page.mouse.move(x, navY);
    await page.mouse.wheel(0, 2_000);
    await page.mouse.wheel(0, -2_000);
    await page.waitForTimeout(300);
    await expectChromeInPlace(page, 'wheel on the nav');
  } else {
    await page.evaluate(() => {
      document.querySelector('[data-list-column]')?.scrollTo(0, 1e6);
    });
    await page.waitForTimeout(200);
    await expectChromeInPlace(page, 'list scrolled to the end');
    await shot(page, 'scrolled-end');
  }
});

test('content outside the frame cannot scroll the document or move the chrome', async ({
  page,
}) => {
  await seedLongList(page, 'frame.outside', 12);
  await expectChromeInPlace(page, 'initial');
  // A body-level layer that reaches below the viewport (a portal, a toast, the drag layer, a
  // viewport-height mismatch): the frame must not be pushed or scrolled.
  await page.evaluate(() => {
    const tall = document.createElement('div');
    tall.style.height = '3000px';
    document.body.append(tall);
  });
  if (chromium()) {
    const cdp = await page.context().newCDPSession(page);
    const nav = (await frameState(page)).nav;
    const navY = Math.round((nav?.top ?? 0) + 20);
    await touchDrag(cdp, 200, navY, navY - 400);
    await page.mouse.move(200, navY);
    await page.mouse.wheel(0, 2_000);
    await page.waitForTimeout(400);
    await shot(page, 'outside-gestures');
    await expectChromeInPlace(page, 'gestures with content below the frame');
  }
  // Even a programmatic scroll (focus, scrollIntoView) leaves the frame where it is.
  await page.evaluate(() => window.scrollTo(0, 800));
  await page.waitForTimeout(100);
  await shot(page, 'outside-scrolled');
  const state = await frameState(page);
  expect(Math.abs((state.nav?.bottom ?? 0) - state.innerHeight)).toBeLessThan(1);
  expect(state.headerTop).toBe(0);
});

test('pull to refresh, past and short of the threshold, leaves the chrome in place', async ({
  page,
}) => {
  await seedLongList(page, 'frame.pull', 30);
  const before = await expectChromeInPlace(page, 'initial');
  const indicator = page.getByTestId('pull-to-refresh');
  const row = await page.getByText('Task 1', { exact: true }).boundingBox();
  const startY = Math.round((row?.y ?? 200) + 10);

  // Every state the indicator passes through (a local refresh settles within a frame or two).
  // One callback can carry several changes (armed → refreshing → idle): each record's old value
  // keeps the states in between, the current one adds the last.
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="pull-to-refresh"]') as HTMLElement;
    const w = window as unknown as { __pullStates: string[] };
    w.__pullStates = [];
    new MutationObserver((records) => {
      for (const record of records) w.__pullStates.push(record.oldValue ?? '');
      w.__pullStates.push(el.dataset.state ?? '');
    }).observe(el, { attributeFilter: ['data-state'], attributeOldValue: true });
  });
  const states = () =>
    page.evaluate(() => (window as unknown as { __pullStates: string[] }).__pullStates);

  // Past the threshold: a refresh runs and the indicator collapses afterwards.
  await pullDown(page, 300, startY, 220);
  await expect.poll(states).toContain('refreshing');
  await expect(indicator).toHaveAttribute('data-state', 'idle');
  await page.waitForTimeout(400);
  let state = await expectChromeInPlace(page, 'after the refresh');
  expect(state.docScrollHeight).toBe(before.docScrollHeight);
  expect(state.nav).toEqual(before.nav);
  expect((await indicator.boundingBox())?.height ?? 0).toBe(0);
  await shot(page, 'pull-refresh');

  // Short of the threshold: no refresh, the indicator springs back.
  await page.evaluate(() => {
    (window as unknown as { __pullStates: string[] }).__pullStates = [];
  });
  await pullDown(page, 300, startY, 60);
  await expect(indicator).toHaveAttribute('data-state', 'idle');
  expect(await states()).toContain('pulling');
  expect(await states()).not.toContain('refreshing');
  await page.waitForTimeout(400);
  state = await expectChromeInPlace(page, 'after a short pull');
  expect(state.docScrollHeight).toBe(before.docScrollHeight);
  expect(state.nav).toEqual(before.nav);

  if (chromium()) {
    // A real finger pulling down at the top: the gesture overscrolls the list, never the root.
    const cdp = await page.context().newCDPSession(page);
    await touchDrag(cdp, 300, startY, startY + 300);
    await expect(indicator).toHaveAttribute('data-state', 'idle', { timeout: 10_000 });
    await page.waitForTimeout(400);
    state = await expectChromeInPlace(page, 'after a native pull');
    expect(state.nav).toEqual(before.nav);
  }
});
