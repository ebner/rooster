import type { Page } from '@playwright/test';
import type { MyList, SavedView, Tag, Task } from '@rooster/core/schemas';
import { expectAxeClean } from './support/a11y';
import { apiCall } from './support/auth';
import { createTask, mod, waitForSync } from './support/p3';
import { paletteAction, paletteInput } from './support/p5-palette';
import { sharedOrg } from './support/p6-people';
import { expect, reload, test } from './support/test';

/**
 * Phase 13, WP 13.4 (ADR 0073 B, 02 §10.2): a view's screen on desktop. AC-13.3 (a shared
 * project view by person, inline add under a member, counts, archive), and AC-13.4's UI part
 * (a deleted tag leaves the view's chips). The sidebar and Org settings → Views have
 * `views-shell.spec.ts`.
 */

const shots = process.env.ROOSTER_P13_SCREENSHOT_DIR;

test.beforeEach(async ({ page }) => {
  if (shots) await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      sessionStorage.setItem('e2e-init', '1');
      localStorage.setItem('rooster.locale', 'en');
    }
  });
});

/** The rows as text: `# <assignee>` for each person section, then its row titles. */
async function outline(page: Page): Promise<string[]> {
  return page
    .locator('[data-list-root] [data-row-id]')
    .evaluateAll((els) =>
      els.flatMap((el) =>
        el.getAttribute('data-testid') === 'member-section'
          ? [`# ${el.getAttribute('data-assignee')}`]
          : el.getAttribute('data-testid') === 'task-row'
            ? [el.querySelector('[data-focus-target]')?.textContent ?? '']
            : [],
      ),
    );
}

async function views(page: Page, orgId: string, archived = false): Promise<SavedView[]> {
  const res = await apiCall(
    page,
    'GET',
    `/api/v1/orgs/${orgId}/views${archived ? '?archived=true' : ''}`,
  );
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as SavedView[];
}

const viewIdOf = (page: Page) => /\/v\/([^/]+)$/.exec(new URL(page.url()).pathname)?.[1] ?? '';

test('AC-13.3 a shared project view: by person, inline add under a member, counts, archive', async ({
  page,
  browser,
}) => {
  const { a, b, slug, orgId, aId, bId } = await sharedOrg(page, browser, 'views.ac133');
  const tagRes = await apiCall(a, 'POST', `/api/v1/orgs/${orgId}/tags`, { name: 'juniper' });
  expect(tagRes.status(), await tagRes.text()).toBe(201);
  const juniper = (await tagRes.json()) as Tag;
  await createTask(a, orgId, { title: 'Draft the brief', tagIds: [juniper.id] });
  await createTask(a, orgId, {
    title: 'Book the photographer',
    tagIds: [juniper.id],
    assigneeId: bId,
  });
  await createTask(a, orgId, { title: 'Not about juniper' });
  const done = await createTask(a, orgId, { title: 'Pick the venue', tagIds: [juniper.id] });
  await apiCall(a, 'POST', `/api/v1/tasks/${done.id}/complete`, { completed: true });

  // "+ New view": named in the header, created, the URL takes its ID.
  await a.goto(`/o/${slug}/v/new`);
  const name = a.getByTestId('view-name');
  await expect(name).toBeFocused();
  await name.fill('Juniper');
  await name.press('Enter');
  await expect(a).toHaveURL(/\/v\/[0-9a-f-]{36}$/);
  const viewId = viewIdOf(a);

  // The query as chips: the tag (a project view), then Shared with the B13 note.
  await a.getByTestId('view-chip-tags').click();
  await a.getByRole('option', { name: 'juniper' }).click();
  await a.keyboard.press('Escape');
  await expect(a.getByTestId('view-chip-tags')).toContainText('juniper');
  await a.getByTestId('view-chip-shared').click();
  await a.getByRole('menuitemradio', { name: 'Shared' }).click();
  await expect(a.getByTestId('view-shared-note')).toContainText(
    'Everyone in Harbour can see these tasks anyway',
  );
  await expect
    .poll(async () => (await views(a, orgId)).find((v) => v.id === viewId))
    .toMatchObject({ name: 'Juniper', shared: true, query: { tags: [juniper.id] } });

  // Rows by person (me, the other member, Unassigned); the header counts open and done.
  await expect
    .poll(() => outline(a))
    .toEqual([`# ${aId}`, 'Draft the brief', `# ${bId}`, 'Book the photographer', '# none']);
  await expect(a.getByTestId('view-counts')).toContainText('2 open · 1 done');

  // B6: typed under the other member, the task gets #juniper and lands atop their Inbox.
  await a
    .locator(`[data-row-id*="member:${bId}"]`)
    .getByRole('button', { name: 'Add task' })
    .click();
  await a.keyboard.type('Order the banners');
  await a.keyboard.press('Escape');
  await waitForSync(a);
  await expect
    .poll(() => outline(a))
    .toEqual([
      `# ${aId}`,
      'Draft the brief',
      `# ${bId}`,
      'Book the photographer',
      'Order the banners',
      '# none',
    ]);
  await expect(a.getByTestId('view-counts')).toContainText('3 open · 1 done');
  const bList = (await (await apiCall(b, 'GET', `/api/v1/orgs/${orgId}/my-list`)).json()) as MyList;
  const inbox = bList.groups.find((g) => g.kind === 'inbox');
  const inInbox = bList.tasks
    .filter((t) => t.placement?.groupId === inbox?.id)
    .sort((x, y) => {
      const [p, q] = [x.placement?.position ?? '', y.placement?.position ?? ''];
      return p < q ? -1 : p > q ? 1 : 0;
    });
  const banners = inInbox[0] as Task;
  expect(banners.title).toBe('Order the banners');
  expect(banners.tagIds).toEqual([juniper.id]);
  expect(banners.assigneeId).toBe(bId);

  if (shots) await a.screenshot({ path: `${shots}/1440-view.png` });
  await expectAxeClean(a, 'view');

  // The other member sees the shared view, with the same rows.
  await b.goto(`/o/${slug}/v/${viewId}`);
  await expect(b.getByTestId('view-name')).toHaveValue('Juniper');
  await expect
    .poll(() => outline(b))
    .toEqual([
      `# ${bId}`,
      'Book the photographer',
      'Order the banners',
      `# ${aId}`,
      'Draft the brief',
      '# none',
    ]);

  // Archive: it leaves the views for everyone; Org settings → Views (the API here) restores it.
  await a.getByTestId('view-menu').click();
  await a.getByTestId('view-menu-archive').click();
  await expect(a).toHaveURL(new RegExp(`/o/${slug}/my$`));
  await expect.poll(async () => (await views(b, orgId)).map((v) => v.id)).not.toContain(viewId);
  expect((await views(b, orgId, true)).map((v) => v.id)).toContain(viewId);
  await apiCall(b, 'POST', `/api/v1/views/${viewId}/restore`);
  await expect.poll(async () => (await views(a, orgId)).map((v) => v.id)).toContain(viewId);
});

test('AC-13.3 a private view is the creator’s only: 404 for another member, a quiet note', async ({
  page,
  browser,
}) => {
  const { a, b, slug, orgId } = await sharedOrg(page, browser, 'views.private');
  const res = await apiCall(a, 'POST', `/api/v1/orgs/${orgId}/views`, {
    name: 'Mine only',
    query: { tags: [], tagMode: 'any', assignee: 'me', due: 'any', status: 'open' },
  });
  expect(res.status(), await res.text()).toBe(201);
  const view = (await res.json()) as SavedView;
  expect(view.shared).toBe(false);
  expect((await apiCall(b, 'GET', `/api/v1/views/${view.id}/tasks`)).status()).toBe(404);
  await b.goto(`/o/${slug}/v/${view.id}`);
  await expect(b.getByTestId('view-not-found')).toBeVisible();
  await b.getByRole('link', { name: 'Back to My tasks' }).click();
  await expect(b).toHaveURL(new RegExp(`/o/${slug}/my$`));
});

test('AC-13.4 deleting the tag removes it from the view’s chips', async ({ page, browser }) => {
  const { a, slug, orgId } = await sharedOrg(page, browser, 'views.tagdel');
  const tag = (await (
    await apiCall(a, 'POST', `/api/v1/orgs/${orgId}/tags`, { name: 'fika' })
  ).json()) as Tag;
  await createTask(a, orgId, { title: 'Bake the buns', tagIds: [tag.id] });
  const view = (await (
    await apiCall(a, 'POST', `/api/v1/orgs/${orgId}/views`, {
      name: 'Fika',
      shared: true,
      query: { tags: [tag.id], tagMode: 'any', assignee: 'anyone', due: 'any', status: 'open' },
    })
  ).json()) as SavedView;
  await a.goto(`/o/${slug}/v/${view.id}`);
  await expect(a.getByTestId('view-chip-tags')).toContainText('fika');
  await expect(a.getByTestId('view-counts')).toBeVisible();
  expect((await apiCall(a, 'DELETE', `/api/v1/tags/${tag.id}`)).status()).toBe(204);
  await reload(a);
  await expect(a.getByTestId('view-chip-tags')).toContainText('Any tag');
  // No tag left: a plain view, no project counts.
  await expect(a.getByTestId('view-counts')).toHaveCount(0);
});

test('B7 Save as view from My tasks’ tag filter and from a palette search', async ({
  page,
  browser,
}) => {
  const { a, slug, orgId } = await sharedOrg(page, browser, 'views.saveas');
  const tag = (await (
    await apiCall(a, 'POST', `/api/v1/orgs/${orgId}/tags`, { name: 'launch' })
  ).json()) as Tag;
  await createTask(a, orgId, { title: 'Write the post', tagIds: [tag.id] });
  await a.goto(`/o/${slug}/my`);
  await a.getByTestId('tag-filter').click();
  await a.getByRole('menuitemcheckbox', { name: 'launch' }).click();
  await a.getByTestId('tag-filter-save-as-view').click();
  await expect(a).toHaveURL(/\/v\/[0-9a-f-]{36}$/);
  await expect(a.getByTestId('view-name')).toHaveValue('launch');
  await expect(a.getByTestId('view-name')).toBeFocused();
  await expect(a.getByTestId('view-chip-tags')).toContainText('launch');

  // The palette: a search with filters offers "Save search as view".
  await a.goto(`/o/${slug}/my`);
  await expect(a.getByRole('treegrid')).toBeVisible();
  await a.keyboard.press(`${mod}+k`);
  await expect(paletteInput(a)).toBeFocused();
  await paletteInput(a).fill('#launch due:week');
  await paletteAction(a, 'Save search as view').click();
  await expect(a).toHaveURL(/\/v\/[0-9a-f-]{36}$/);
  await expect(a.getByTestId('view-chip-due')).toContainText('Next 7 days');
  await reload(a);
  await expect(a.getByTestId('view-chip-due')).toContainText('Next 7 days');
});
