import { mod } from './support/p3';
import { percentile, seed2000 } from './support/perf';
import { expect, test } from './support/test';

/**
 * WP 11.4, AC-11.4 (ADR 0052 §8): My tasks with 2,000 open tasks. Keypress → paint for create,
 * complete and move stays at a p95 ≤ 50 ms (the AC-2.12 budget); the initial render and
 * scrolling are measured and reported. Runs in the `perf` project, alone; the seeding is in
 * support/perf.ts.
 */

// Against the production build (the `pwa` server in playwright.config.ts): a 2,000-row budget
// is about the shipped app, not React's development build. PERF_BASE_URL overrides it.
test.use({ trace: 'off', baseURL: process.env.PERF_BASE_URL ?? 'http://localhost:3182' });

test('AC-11.4 with 2,000 open tasks in My tasks, keypress to paint stays under 50 ms (p95); render and scroll are reported', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(600_000);
  const org = await seed2000(page, browser);

  // Initial render: navigation start → all 2,000 rows in the DOM, then the first paint after.
  await page.goto(`/o/${org.slug}/my`);
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="task-row"]').length >= 2000,
    undefined,
    { timeout: 60_000, polling: 'raf' },
  );
  const renderMs = await page.evaluate(
    () => new Promise<number>((resolve) => requestAnimationFrame(() => resolve(performance.now()))),
  );
  await expect(page.getByTestId('task-row')).toHaveCount(2000);

  // Scrolling: the list's scroller moves 120 px per frame from the top to the bottom.
  const frames = await page.evaluate(async () => {
    let el = document.querySelector('[data-list-root]')?.parentElement ?? null;
    while (el && el.scrollHeight <= el.clientHeight) el = el.parentElement;
    if (!el) return [];
    const scroller = el;
    scroller.scrollTop = 0;
    const deltas: number[] = [];
    await new Promise<void>((resolve) => {
      let last = performance.now();
      const step = (now: number) => {
        deltas.push(now - last);
        last = now;
        scroller.scrollTop += 120;
        if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1) resolve();
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    scroller.scrollTop = 0;
    return deltas.slice(1);
  });
  const longFrames = frames.filter((f) => f > (1000 / 60) * 1.5).length;
  const scroll = {
    frames: frames.length,
    p50: percentile(frames, 0.5),
    p95: percentile(frames, 0.95),
    max: Math.max(...frames),
    longFrames,
  };

  await page.evaluate(() => {
    const samples: number[] = [];
    (window as { __samples?: number[] }).__samples = samples;
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Shift' || event.key === 'Control' || event.key === 'Meta') return;
        const start = event.timeStamp;
        requestAnimationFrame(() => setTimeout(() => samples.push(performance.now() - start), 0));
      },
      true,
    );
  });
  const results: Record<string, number> = {};
  const measure = async (label: string, action: () => Promise<void>, times = 40) => {
    await page.evaluate(() => {
      (window as { __samples?: number[] }).__samples?.splice(0);
    });
    for (let i = 0; i < times; i++) {
      await action();
      await page.waitForTimeout(120);
    }
    const samples = await page.evaluate(() => [
      ...((window as { __samples?: number[] }).__samples ?? []),
    ]);
    const p95 = percentile(samples, 0.95);
    results[label] = p95;
    console.warn(
      `AC-11.4 ${label}: p95 ${p95.toFixed(1)} ms over ${samples.length} samples`,
      [...samples]
        .sort((a, b) => a - b)
        .map(Math.round)
        .join(','),
    );
    expect.soft(p95, label).toBeLessThan(50);
  };

  const row = (title: string) =>
    page
      .getByTestId('task-row')
      .filter({ has: page.locator('[data-focus-target]').getByText(title, { exact: true }) });

  // Create: Enter in Edit on a typed title (each Enter commits and opens the next draft).
  await row('Prio 80').getByText('Prio 80', { exact: true }).click();
  await page.keyboard.press('End');
  await measure('create', async () => {
    await page.keyboard.press('Enter');
    // The next title is typed a moment later, as a person would: typed at once, its input
    // events would land inside the Enter's frame and be counted as part of it.
    await page.waitForTimeout(60);
    await page.keyboard.insertText('perf');
  });
  await page.keyboard.press('Escape');

  // Move: Ctrl+↓ on the selected row.
  await row('Today 40').locator('[data-drag-handle]').click();
  await measure('move', async () => {
    await page.keyboard.press(`${mod}+ArrowDown`);
  });

  // Complete: Ctrl+Enter toggles (complete, then un-complete in the hold window).
  await measure('complete', async () => {
    await page.keyboard.press(`${mod}+Enter`);
  });

  // Off-screen chunks skip rendering on screen, but print renders every row (print.css).
  const rendered = () =>
    page.evaluate(
      () =>
        [...document.querySelectorAll('[data-list-root] [data-testid="task-row"]')].filter((row) =>
          row.checkVisibility({ contentVisibilityAuto: true }),
        ).length,
    );
  const onScreen = await rendered();
  expect(onScreen).toBeLessThan(500);
  await page.emulateMedia({ media: 'print' });
  await expect.poll(rendered).toBeGreaterThanOrEqual(2000);
  await page.emulateMedia({ media: 'screen' });

  const report = {
    initialRenderMs: Math.round(renderMs),
    rowsRenderedOnScreen: onScreen,
    scroll: Object.fromEntries(
      Object.entries(scroll).map(([k, v]) => [k, Math.round(v * 10) / 10]),
    ),
    keypressToPaintP95Ms: Object.fromEntries(
      Object.entries(results).map(([k, v]) => [k, Math.round(v * 10) / 10]),
    ),
  };
  console.warn('AC-11.4 report', JSON.stringify(report));
  await testInfo.attach('ac-11.4.json', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
});
