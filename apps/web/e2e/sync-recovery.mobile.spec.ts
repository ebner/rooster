import type { BrowserContext, Page } from '@playwright/test';
import { signInAs, uniqueEmail } from './support/auth';
import { myList, personalOrg } from './support/p3';
import { syncPill } from './support/pwa';
import { expect, test } from './support/test';

/**
 * "Syncing…" forever on a phone (1.0.0): queued edits that were never sent, or never cleared.
 * Two ways the outbox got stuck, each recovered from here.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      sessionStorage.setItem('e2e-init', '1');
      localStorage.setItem('rooster.locale', 'en');
    }
  });
});

const pending = (page: Page) => page.getByTestId('sync-state');
const row = (page: Page, title: string) =>
  page.getByTestId('task-row').filter({ hasText: title }).first();

async function holdsOutboxLock(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const state = await navigator.locks.query();
    return (state.held ?? []).some((lock) => lock.name === 'rooster-outbox');
  });
}

/** Task creates as they leave the page. */
function recordCreates(page: Page): string[] {
  const out: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/api\/v1\/orgs\/[^/]+\/tasks$/.test(request.url())) {
      out.push((request.postDataJSON() as { title?: string }).title ?? '');
    }
  });
  return out;
}

/** Opens the app in a second page of the same profile (the Chrome tab next to the PWA). */
async function secondInstance(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto('/o/personal/my');
  await expect(page.getByTestId('task-row').or(page.getByRole('treegrid')).first()).toBeVisible();
  return page;
}

/** Freezes the page's JavaScript; resolves to the function that thaws it. */
async function freeze(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Debugger.enable');
  await cdp.send('Debugger.pause');
  return async () => {
    await cdp.send('Debugger.resume');
    await cdp.send('Debugger.disable');
    await cdp.detach();
  };
}

async function addTaskWithFab(page: Page, title: string) {
  await page.getByRole('button', { name: 'New task' }).tap();
  const input = page.locator('[data-list-input]');
  await expect(input).toBeFocused();
  await input.fill(title);
  await page.getByTestId('accessory-bar').getByRole('button', { name: 'Next' }).click();
  await expect(row(page, title)).toBeVisible();
  await page.keyboard.press('Escape');
}

/**
 * The installed PWA and a Chrome tab share the origin, its Web Lock `rooster-outbox` and its
 * IndexedDB outbox. Android freezes a backgrounded page without releasing the locks it holds,
 * so the frozen instance stayed the leader and the one in front mirrored its own edits forever
 * without sending them.
 *
 * Headless Chromium never freezes a page (`Page.setWebLifecycleState` refuses visible pages and
 * every headless page is visible), so the leader is frozen by pausing its JavaScript in the
 * debugger: like a frozen page, it holds its lock, answers nothing and runs nothing until it
 * resumes. Chromium only (CDP).
 */
test('a frozen leader does not block the visible instance: its edits sync', async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'pausing a page needs CDP (Chromium)');
  await signInAs(page, uniqueEmail('sync.frozen.leader'));
  const orgId = await personalOrg(page);
  await expect(page.getByRole('button', { name: 'New task' })).toBeVisible();
  await expect.poll(() => holdsOutboxLock(page)).toBe(true);
  const front = await secondInstance(context);
  const sentByFirst = recordCreates(page);
  const sentByFront = recordCreates(front);

  // The first instance (the leader) goes to the background and Android freezes it.
  const thaw = await freeze(context, page);
  await addTaskWithFab(front, 'Written while the PWA sleeps');

  // The instance in front finds the leader unresponsive, takes the lock and sends.
  await expect(pending(front)).toHaveAttribute('data-pending', '0', { timeout: 15_000 });
  await expect(syncPill(front)).toHaveCount(0);
  expect(sentByFront).toEqual(['Written while the PWA sleeps']);
  await expect
    .poll(async () => (await myList(front, orgId)).tasks.map((t) => t.title))
    .toContain('Written while the PWA sleeps');

  // Thawed, the old leader catches up and follows: no stale "Syncing…" there either.
  await thaw();
  await expect(pending(page)).toHaveAttribute('data-pending', '0', { timeout: 15_000 });
  await expect(syncPill(page)).toHaveCount(0);
  await expect(row(page, 'Written while the PWA sleeps')).toBeVisible();

  // Its own edits now go out through the new leader.
  await addTaskWithFab(page, 'Back in front');
  await expect(pending(page)).toHaveAttribute('data-pending', '0', { timeout: 15_000 });
  await expect(pending(front)).toHaveAttribute('data-pending', '0');
  expect(sentByFront).toContain('Back in front');
  expect(sentByFirst).not.toContain('Back in front');
  const titles = (await myList(page, orgId)).tasks.map((t) => t.title);
  expect(titles.filter((t) => t === 'Written while the PWA sleeps')).toHaveLength(1);
  expect(titles.filter((t) => t === 'Back in front')).toHaveLength(1);
});

/**
 * The server processed the create (201 in its log) but the answer never reached the phone: the
 * connection died while it slept or switched networks. Without a timeout the request stayed
 * pending, the queue behind it never moved and nothing was ever retried.
 */
test('a write whose answer never arrives is retried with the same key', async ({ page }) => {
  test.setTimeout(90_000);
  await signInAs(page, uniqueEmail('sync.lost.answer'));
  const orgId = await personalOrg(page);
  await expect(page.getByRole('button', { name: 'New task' })).toBeVisible();
  const keys: string[] = [];
  await page.route('**/api/v1/orgs/*/tasks', async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.continue();
    keys.push((await request.allHeaders())['idempotency-key'] ?? '');
    if (keys.length > 1) return route.continue();
    // Reaches the server, but the answer is lost: the page never hears back.
    await route.fetch();
  });

  await addTaskWithFab(page, 'Answer lost');
  await expect(syncPill(page)).toHaveText(/Syncing/);
  await expect(pending(page)).toHaveAttribute('data-pending', '0', { timeout: 45_000 });
  await expect(syncPill(page)).toHaveCount(0);
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  const titles = (await myList(page, orgId)).tasks.map((t) => t.title);
  expect(titles.filter((t) => t === 'Answer lost')).toHaveLength(1);
});
