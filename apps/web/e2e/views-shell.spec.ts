import type { Page } from '@playwright/test';
import type { SavedView, SavedViewCreate, Tag } from '@rooster/core/schemas';
import { expectAxeClean } from './support/a11y';
import { apiCall } from './support/auth';
import { createTask } from './support/p3';
import { sharedOrg } from './support/p6-people';
import { expect, openKitchenSink, reload, test } from './support/test';

/**
 * Phase 13, WP 13.4 (ADR 0073 B9, B10, B13): the shell around views on desktop. The sidebar's
 * Views part (per-member order, counts, icons, private views), Org settings → Views (archive,
 * restore, delete) and AC-13.3's sidebar parts. The view screen itself has its own spec.
 */

const shots = process.env.ROOSTER_P13_SCREENSHOTS;
const shotDir = process.env.ROOSTER_P13_SCREENSHOT_DIR ?? 'test-results/p13-shell';

test.beforeEach(async ({ page }) => {
  if (shots) await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      sessionStorage.setItem('e2e-init', '1');
      localStorage.setItem('rooster.locale', 'en');
    }
  });
});

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Main' });
const viewList = (page: Page, org: string) =>
  sidebar(page).getByRole('list', { name: `Views in ${org}` });
/** The org's views in the sidebar, by name (the link text without its count). */
const sidebarViews = (page: Page, org: string) =>
  viewList(page, org)
    .locator('[data-view-id]')
    .evaluateAll((rows) =>
      rows.map((row) => row.querySelector('a span.truncate')?.textContent ?? ''),
    );

async function createView(page: Page, orgId: string, body: SavedViewCreate): Promise<SavedView> {
  const res = await apiCall(page, 'POST', `/api/v1/orgs/${orgId}/views`, body);
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as SavedView;
}

const query = (tags: string[] = [], assignee = 'anyone') => ({
  tags,
  tagMode: 'any' as const,
  assignee,
  due: 'any' as const,
  status: 'open' as const,
});

test('AC-13.3 shared views in every member’s sidebar, ordered per member; private ones stay private', async ({
  page,
  browser,
}) => {
  const { a, b, slug, orgId, bId } = await sharedOrg(page, browser, 'views.shell');
  const tagRes = await apiCall(a, 'POST', `/api/v1/orgs/${orgId}/tags`, { name: 'juniper' });
  expect(tagRes.status(), await tagRes.text()).toBe(201);
  const juniperTag = (await tagRes.json()) as Tag;
  await createTask(a, orgId, { title: 'Order the beams', tagIds: [juniperTag.id] });
  await createTask(a, orgId, { title: 'Pour the slab', tagIds: [juniperTag.id], assigneeId: bId });
  await createTask(a, orgId, { title: 'Untagged', assigneeId: bId });

  const juniper = await createView(a, orgId, {
    name: 'Juniper',
    query: query([juniperTag.id]),
    shared: true,
  });
  const waiting = await createView(a, orgId, {
    name: 'Waiting',
    query: query([], 'unassigned'),
    shared: true,
  });
  const mine = await createView(a, orgId, { name: 'Mine', query: query([], 'me'), shared: false });

  // A: the three views after Everyone's tasks, a `#` for the project view, its open count.
  await a.goto(`/o/${slug}/my`);
  await expect.poll(() => sidebarViews(a, 'Harbour')).toEqual(['Juniper', 'Waiting', 'Mine']);
  const juniperRow = viewList(a, 'Harbour').locator(`[data-view-id="${juniper.id}"]`);
  await expect(juniperRow).toHaveAttribute('data-project', '');
  await expect(juniperRow.getByRole('link')).toHaveText('Juniper2');
  await expect(juniperRow.getByRole('link')).toHaveAttribute('href', `/o/${slug}/v/${juniper.id}`);
  await expect(
    viewList(a, 'Harbour').locator(`[data-view-id="${waiting.id}"]`),
  ).not.toHaveAttribute('data-project');
  const harbourLinks = sidebar(a).getByRole('region', { name: 'Harbour' }).getByRole('link');
  const texts = await harbourLinks.allTextContents();
  expect(texts.indexOf('Juniper2')).toBe(texts.indexOf("Everyone's tasks") + 1);
  expect(texts.at(-1)).toBe('New view');
  if (shots) {
    await sidebar(a)
      .getByRole('region', { name: 'Harbour' })
      .screenshot({ path: `${shotDir}/sidebar-views.png` });
  }

  // B: the shared ones only; the private view doesn't exist for B (API 404).
  await b.goto(`/o/${slug}/my`);
  await expect.poll(() => sidebarViews(b, 'Harbour')).toEqual(['Juniper', 'Waiting']);
  for (const [method, path] of [
    ['GET', `/api/v1/views/${mine.id}/tasks`],
    ['PATCH', `/api/v1/views/${mine.id}`],
  ] as const) {
    const res = await apiCall(b, method, path, method === 'PATCH' ? { name: 'Mine?' } : undefined);
    expect(res.status(), `${method} ${path}`).toBe(404);
  }

  // B moves Waiting above Juniper from the keyboard: B's order only.
  const grip = viewList(b, 'Harbour').getByRole('button', { name: 'Reorder Waiting' });
  await grip.focus();
  const live = b.getByRole('status').filter({ hasText: /Waiting/ });
  await b.keyboard.press('Space');
  await expect(live).toHaveText('Picked up Waiting. Position 2 of 2.');
  // The sensor starts listening a moment after the pick-up is announced; a key before that is
  // lost (never passed to the list: the lifted grip keeps the keys), so press until it moves.
  await expect(async () => {
    await b.keyboard.press('ArrowUp');
    await expect(live).toHaveText('Waiting is at position 1 of 2.', { timeout: 500 });
  }).toPass();
  // The list's cursor stayed out of it: focus is still on the grip.
  await expect(grip).toBeFocused();
  await b.keyboard.press('Space');
  await expect.poll(() => sidebarViews(b, 'Harbour')).toEqual(['Waiting', 'Juniper']);
  await reload(b);
  await expect.poll(() => sidebarViews(b, 'Harbour')).toEqual(['Waiting', 'Juniper']);
  await reload(a);
  await expect.poll(() => sidebarViews(a, 'Harbour')).toEqual(['Juniper', 'Waiting', 'Mine']);

  // The links lead to a new view and to the view.
  await expect(
    sidebar(b).getByRole('region', { name: 'Harbour' }).getByRole('link', { name: 'New view' }),
  ).toHaveAttribute('href', `/o/${slug}/v/new`);
  await viewList(b, 'Harbour')
    .getByRole('link', { name: /^Waiting/ })
    .click();
  await expect(b).toHaveURL(new RegExp(`/o/${slug}/v/${waiting.id}$`));
  await expect(viewList(b, 'Harbour').getByRole('link', { name: /^Waiting/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(
    sidebar(b)
      .getByRole('region', { name: 'Harbour' })
      .getByRole('link', { name: /^My tasks/ }),
  ).not.toHaveAttribute('aria-current', 'page');
});

test('AC-13.3 archiving hides a view from everyone; Org settings → Views restores and deletes', async ({
  page,
  browser,
}) => {
  const { a, b, slug, orgId } = await sharedOrg(page, browser, 'views.archive');
  const juniper = await createView(a, orgId, {
    name: 'Juniper',
    query: query(),
    shared: true,
  });
  await createView(a, orgId, { name: 'Launch', query: query(), shared: true });

  await b.goto(`/o/${slug}/my`);
  await expect.poll(() => sidebarViews(b, 'Harbour')).toEqual(['Juniper', 'Launch']);

  await a.goto(`/o/${slug}/settings`);
  const section = a.getByRole('region', { name: 'Views' });
  await expect(
    section.getByText('Everyone in Harbour can see these tasks anyway; a view only gathers them.'),
  ).toBeVisible();
  await section.getByRole('button', { name: 'Archive Juniper' }).click();
  await expect(a.getByText('Archived “Juniper”')).toBeVisible();
  const archived = section.getByRole('list', { name: 'Archived' });
  await expect(archived.getByText('Juniper')).toBeVisible();
  await expect.poll(() => sidebarViews(a, 'Harbour')).toEqual(['Launch']);
  // Another member's sidebar follows (SSE).
  await expect.poll(() => sidebarViews(b, 'Harbour')).toEqual(['Launch']);
  if (shots) await a.screenshot({ path: `${shotDir}/org-settings-views.png`, fullPage: true });

  // B restores it: back in both sidebars, at the end of each member's order.
  await b.goto(`/o/${slug}/settings`);
  await b
    .getByRole('region', { name: 'Views' })
    .getByRole('button', { name: 'Restore Juniper' })
    .click();
  await expect(b.getByText('Restored “Juniper”')).toBeVisible();
  await expect.poll(() => sidebarViews(b, 'Harbour')).toEqual(['Launch', 'Juniper']);
  await expect.poll(() => sidebarViews(a, 'Harbour')).toEqual(['Launch', 'Juniper']);

  // Delete asks inline first.
  await section.getByRole('button', { name: 'Delete Juniper' }).click();
  const confirm = section.getByRole('group', { name: 'Delete view' });
  await expect(confirm).toContainText('Delete the view “Juniper” for everyone who sees it?');
  await confirm.getByRole('button', { name: 'Delete view' }).click();
  await expect(a.getByText('Deleted “Juniper”')).toBeVisible();
  await expect.poll(() => sidebarViews(a, 'Harbour')).toEqual(['Launch']);
  const gone = await apiCall(a, 'GET', `/api/v1/views/${juniper.id}/tasks`);
  expect(gone.status()).toBe(404);
});

test('an org without views shows only "New view"', async ({ page, browser }) => {
  const { a, slug } = await sharedOrg(page, browser, 'views.empty');
  await a.goto(`/o/${slug}/my`);
  const harbour = sidebar(a).getByRole('region', { name: 'Harbour' });
  await expect(harbour.getByRole('link', { name: 'New view' })).toHaveAttribute(
    'href',
    `/o/${slug}/v/new`,
  );
  await expect(viewList(a, 'Harbour')).toHaveCount(0);
});

test('the kitchen sink shows the views’ shell parts, accessibly', async ({ page }) => {
  await openKitchenSink(page, '#views');
  const group = (title: string) =>
    page.getByRole('heading', { level: 3, name: title, exact: true }).locator('..');
  const sidebarGroup = group('Views in the sidebar (project #, plain ⌕, counts, active)');
  await expect(
    sidebarGroup.getByRole('list', { name: 'Views in Northwind' }).first(),
  ).toBeVisible();
  const tabs = group('Phone view switcher with views');
  await expect(tabs.getByRole('link', { name: 'Juniper' })).toHaveAttribute('aria-current', 'page');
  const settings = group('Organisation settings → Views');
  await expect(settings.getByRole('button', { name: 'Restore Website relaunch' })).toBeVisible();
  if (shots) {
    await page.setViewportSize({ width: 1440, height: 1600 });
    for (const [locator, name] of [
      [sidebarGroup, 'kitchen-sidebar'],
      [tabs, 'kitchen-tabs'],
      [settings, 'kitchen-settings'],
    ] as const) {
      await locator.scrollIntoViewIfNeeded();
      await locator.screenshot({ path: `${shotDir}/${name}.png` });
    }
  }
  await expectAxeClean(page, 'kitchen sink: views shell', '#views');
});
