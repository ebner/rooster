import type { Page } from '@playwright/test';
import { apiCall, signInAs, uniqueEmail } from './support/auth';
import { expect, test } from './support/test';

/**
 * AC-2.12 (09 §Phase 2): keypress → paint with 500 tasks. Runs in the `perf` project after
 * every other test, alone, so parallel workers do not skew the timings.
 */

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

function rows(page: Page) {
  return page.getByTestId('task-row');
}

test('AC-2.12 with 500 tasks, keypress to paint for create, complete and move stays under 50 ms (p95)', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signInAs(page, uniqueEmail('ac.twotwelve'));
  await expect(page.getByRole('treegrid')).toBeVisible();
  const me = (await (await apiCall(page, 'GET', '/api/v1/me')).json()) as {
    orgs: { id: string; isPersonal: boolean }[];
  };
  const orgId = me.orgs.find((o) => o.isPersonal)?.id as string;
  const list = (await (await apiCall(page, 'GET', `/api/v1/orgs/${orgId}/my-list`)).json()) as {
    groups: { id: string; name: string }[];
  };
  const prio = list.groups.find((g) => g.name === 'Prio') as { id: string };
  // Seed 500 tasks through the API (under the 600/min rate limit).
  await page.evaluate(
    async ({ orgId: org, groupId }) => {
      for (let start = 0; start < 500; start += 25) {
        await Promise.all(
          Array.from({ length: 25 }, (_, i) =>
            fetch(`/api/v1/orgs/${org}/tasks`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                title: `Task ${start + i}`,
                groupId,
                afterId: null,
                beforeId: null,
              }),
            }),
          ),
        );
      }
    },
    { orgId, groupId: prio.id },
  );
  await page.reload();
  await expect(rows(page)).toHaveCount(500, { timeout: 30_000 });

  // keydown (capture) → the frame after React commits.
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
  const measure = async (label: string, action: () => Promise<void>, times = 40) => {
    await page.evaluate(() => {
      (window as { __samples?: number[] }).__samples?.splice(0);
    });
    // Spaced like typing: the budget is per keypress, not a burst's queueing delay.
    for (let i = 0; i < times; i++) {
      await action();
      await page.waitForTimeout(120);
    }
    const samples = await page.evaluate(() => [
      ...((window as { __samples?: number[] }).__samples ?? []),
    ]);
    const sorted = samples.sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
    console.warn(
      `AC-2.12 ${label}: p95 ${p95.toFixed(1)} ms over ${sorted.length} samples`,
      sorted.map(Math.round).join(','),
    );
    expect(p95, label).toBeLessThan(50);
  };

  // Create: Enter in Edit on a typed title (each Enter commits and opens the next draft).
  await rows(page)
    .filter({ hasText: 'Task 10' })
    .first()
    .getByText('Task 10', { exact: true })
    .click();
  await page.keyboard.press('End');
  await measure('create', async () => {
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('perf');
  });
  await page.keyboard.press('Escape');

  // Move: Ctrl+↓ on the selected row.
  await rows(page)
    .filter({ hasText: 'Task 200' })
    .first()
    .click({ position: { x: 4, y: 10 } });
  await measure('move', async () => {
    await page.keyboard.press(`${mod}+ArrowDown`);
  });

  // Complete: Ctrl+Enter toggles (complete, then un-complete in the hold window).
  await measure('complete', async () => {
    await page.keyboard.press(`${mod}+Enter`);
  });
});
