import type { BrowserContext, Page, Request } from '@playwright/test';
import type { MyList, Task } from '@rooster/core/schemas';
import { apiCall, newClient, signInAs, uniqueEmail } from './support/auth';
import { createTask, groupId, myList, personalOrg } from './support/p3';
import { swActive, syncPill, waitForPending, waitForPersistedLists } from './support/pwa';
import { expect, test } from './support/test';

/**
 * Phase 4 offline and sync (AC-4.1–4.4) against the production build with its service worker.
 * The second "device" is another browser context signed in as the same user.
 */

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

function rows(page: Page) {
  return page.getByTestId('task-row');
}

async function visibleTitles(page: Page, groupName: string): Promise<string[]> {
  return page.evaluate((name) => {
    const out: string[] = [];
    let inGroup = false;
    for (const row of document.querySelectorAll<HTMLElement>('[data-list-root] [data-row-id]')) {
      if (row.dataset.testid === 'group-header') {
        inGroup = row.querySelector('h2')?.textContent === name;
      } else if (inGroup && row.dataset.testid === 'task-row') {
        const input = row.querySelector('input[data-list-input]') as HTMLInputElement | null;
        out.push(
          input ? input.value : (row.querySelector('[data-focus-target]')?.textContent ?? ''),
        );
      }
    }
    return out;
  }, groupName);
}

/** List mutations as they leave the page (method + path), in order. */
function recordMutations(page: Page): string[] {
  const out: string[] = [];
  page.on('request', (request: Request) => {
    const url = new URL(request.url());
    if (
      request.method() !== 'GET' &&
      url.pathname.startsWith('/api/v1/') &&
      !url.pathname.startsWith('/api/v1/events')
    ) {
      out.push(`${request.method()} ${url.pathname}`);
    }
  });
  return out;
}

async function openSecondDevice(browser: Parameters<typeof newClient>[0], email: string) {
  const context = await newClient(browser);
  const page = await context.newPage();
  await signInAs(page, email);
  await expect(page.getByRole('treegrid')).toBeVisible();
  return { context, page };
}

/** Selects a row by clicking its drag handle (Navigate mode on that row, no pane). */
async function selectRow(page: Page, title: string) {
  await rows(page).filter({ hasText: title }).locator('[data-drag-handle]').click();
}

async function renameRow(page: Page, from: string, to: string) {
  await rows(page).filter({ hasText: from }).getByText(from, { exact: true }).click();
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.type(to);
  await page.keyboard.press('Escape');
  await expect(rows(page).filter({ hasText: to })).toHaveCount(1);
}

async function goOffline(context: BrowserContext, page: Page) {
  await context.setOffline(true);
  await expect(syncPill(page)).toContainText('Offline');
}

test('AC-4.1 offline reload renders the shell and My tasks of every org from the cache', async ({
  page,
  context,
}) => {
  await signInAs(page, uniqueEmail('pwa.offline.read'));
  const personal = await personalOrg(page);
  const created = await apiCall(page, 'POST', '/api/v1/orgs', { name: 'Choir' });
  expect(created.status()).toBe(201);
  const choir = (await created.json()) as { id: string; slug: string };
  await createTask(page, personal, {
    title: 'Personal errand',
    groupId: await groupId(page, personal, 'Today'),
  });
  await createTask(page, choir.id, {
    title: 'Choir rehearsal',
    groupId: await groupId(page, choir.id, 'Today'),
  });

  // One online visit: the worker precaches the shell, the cache stores every org's list
  // (Choir is never opened: the engine prefetches all orgs).
  await page.reload();
  await expect(rows(page).filter({ hasText: 'Personal errand' })).toBeVisible();
  await swActive(page);
  await waitForPersistedLists(page, [personal, choir.id]);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('treegrid')).toBeVisible();
  await expect(rows(page).filter({ hasText: 'Personal errand' })).toBeVisible();
  // Rendered from the cache: no skeleton on this cold start.
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await expect(syncPill(page)).toHaveText('Offline');

  await page.getByRole('region', { name: 'Choir' }).getByRole('link', { name: 'My tasks' }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${choir.slug}/my$`));
  await expect(rows(page).filter({ hasText: 'Choir rehearsal' })).toBeVisible();

  // A deep link, still offline: the worker serves the shell for any app path.
  await page.goto(`/o/${choir.slug}/my`);
  await expect(rows(page).filter({ hasText: 'Choir rehearsal' })).toBeVisible();
});

test('AC-4.2 offline edits queue, sync in order, reach another device, and never duplicate', async ({
  page,
  context,
  browser,
}) => {
  const email = uniqueEmail('pwa.offline.write');
  await signInAs(page, email);
  const orgId = await personalOrg(page);
  const today = await groupId(page, orgId, 'Today');
  await createTask(page, orgId, { title: 'Finish me', groupId: today });
  await createTask(page, orgId, {
    title: 'Move me',
    groupId: today,
    afterId: null,
    beforeId: null,
  });
  await page.reload();
  await expect.poll(() => visibleTitles(page, 'Today')).toEqual(['Finish me', 'Move me']);
  await swActive(page);
  const device2 = await openSecondDevice(browser, email);
  const mutations = recordMutations(page);

  await goOffline(context, page);
  await page.getByRole('button', { name: 'Add task' }).first().click();
  for (const title of ['One', 'Two', 'Three']) {
    await page.keyboard.type(title);
    await page.keyboard.press('Enter');
  }
  await page.keyboard.press('Escape');
  const finish = rows(page).filter({ hasText: 'Finish me' });
  await finish.locator('label').click();
  await expect(finish).toHaveAttribute('data-done', 'true');
  await selectRow(page, 'Move me');
  await page.keyboard.press(`${mod}+Shift+ArrowDown`);
  await expect.poll(() => visibleTitles(page, 'Prio')).toEqual(['Move me']);

  await expect(syncPill(page)).toHaveText('Offline · 5 pending');
  await waitForPending(page, 5);
  expect(mutations).toEqual([]);

  // The connection drops after the server processed the second create: the retry carries
  // the same Idempotency-Key and gets the stored answer.
  let dropped = false;
  await page.route('**/api/v1/orgs/*/tasks', async (route) => {
    const body = route.request().postData() ?? '';
    if (!dropped && body.includes('"Two"')) {
      dropped = true;
      await route.fetch();
      await route.abort('connectionreset');
      return;
    }
    await route.continue();
  });

  await context.setOffline(false);
  await waitForPending(page, 0);
  expect(dropped).toBe(true);
  // In order; the create cut off mid-flight was sent twice with the same Idempotency-Key.
  expect(mutations).toEqual([
    `POST /api/v1/orgs/${orgId}/tasks`,
    `POST /api/v1/orgs/${orgId}/tasks`,
    `POST /api/v1/orgs/${orgId}/tasks`,
    `POST /api/v1/orgs/${orgId}/tasks`,
    expect.stringMatching(/^POST \/api\/v1\/tasks\/[^/]+\/complete$/),
    expect.stringMatching(/^POST \/api\/v1\/tasks\/[^/]+\/move$/),
  ]);
  await expect(syncPill(page)).toHaveCount(0);

  const list: MyList = await myList(page, orgId);
  const titles = list.tasks.map((t) => t.title);
  expect(titles.filter((t) => t === 'Two')).toHaveLength(1);
  expect(titles).toEqual(expect.arrayContaining(['One', 'Two', 'Three']));
  expect(list.tasks.find((t) => t.title === 'Finish me')?.completedAt).not.toBeNull();
  const prio = list.groups.find((g) => g.name === 'Prio');
  expect(list.tasks.find((t) => t.title === 'Move me')?.placement?.groupId).toBe(prio?.id);

  // The other device got it over SSE, without a reload.
  await expect
    .poll(() => visibleTitles(device2.page, 'Prio'), { timeout: 2_000 })
    .toEqual(['Move me']);
  await expect
    .poll(
      async () => (await visibleTitles(device2.page, 'Today')).filter((t) => t !== 'Finish me'),
      {
        timeout: 2_000,
      },
    )
    .toEqual(['One', 'Two', 'Three']);
  await device2.context.close();
});

test('AC-4.3 last write wins per field: a later online rename beats an earlier offline one', async ({
  page,
  context,
  browser,
}) => {
  const email = uniqueEmail('pwa.lww');
  await signInAs(page, email);
  const orgId = await personalOrg(page);
  const task = await createTask(page, orgId, {
    title: 'Original',
    groupId: await groupId(page, orgId, 'Today'),
  });
  await page.reload();
  await expect(rows(page).filter({ hasText: 'Original' })).toBeVisible();
  const device2 = await openSecondDevice(browser, email);

  await goOffline(context, page);
  await renameRow(page, 'Original', 'From A'); // t1
  await waitForPending(page, 1);

  // t2 > t1: device B renames online.
  const renamed = await apiCall(device2.page, 'PATCH', `/api/v1/tasks/${task.id}`, {
    title: 'From B',
  });
  expect(renamed.status()).toBe(200);

  await context.setOffline(false);
  await waitForPending(page, 0);
  await expect(rows(page).filter({ hasText: 'From B' })).toBeVisible();
  await expect(rows(page).filter({ hasText: 'From A' })).toHaveCount(0);
  const list = await myList(page, orgId);
  expect(list.tasks.find((t: Task) => t.id === task.id)?.title).toBe('From B');
  await device2.context.close();
});

test('AC-4.4 an op on a task deleted elsewhere is dropped with a toast and the list corrected', async ({
  page,
  context,
  browser,
}) => {
  const email = uniqueEmail('pwa.drop');
  await signInAs(page, email);
  const orgId = await personalOrg(page);
  const today = await groupId(page, orgId, 'Today');
  await createTask(page, orgId, { title: 'Keep', groupId: today });
  const doomed = await createTask(page, orgId, { title: 'Doomed', groupId: today });
  await page.reload();
  await expect.poll(() => visibleTitles(page, 'Today')).toEqual(['Keep', 'Doomed']);
  const device2 = await openSecondDevice(browser, email);

  await goOffline(context, page);
  await renameRow(page, 'Doomed', 'Doomed but edited');
  const removed = await apiCall(device2.page, 'DELETE', `/api/v1/tasks/${doomed.id}`);
  expect(removed.status()).toBeLessThan(300);

  await context.setOffline(false);
  await expect(
    page.getByRole('alert').filter({ hasText: /Couldn’t save “Doomed but edited”/ }),
  ).toBeVisible();
  await waitForPending(page, 0);
  await expect.poll(() => visibleTitles(page, 'Today')).toEqual(['Keep']);
  await device2.context.close();
});

test('two tabs share one outbox: only the leader tab sends', async ({ context }) => {
  const first = await context.newPage();
  await signInAs(first, uniqueEmail('pwa.tabs'));
  const orgId = await personalOrg(first);
  await expect(first.getByRole('treegrid')).toBeVisible();
  const second = await context.newPage();
  await second.goto('/o/personal/my');
  await expect(second.getByRole('treegrid')).toBeVisible();
  const sentByFirst = recordMutations(first);
  const sentBySecond = recordMutations(second);

  await second.getByRole('button', { name: 'Add task' }).first().click();
  for (const title of ['From tab 2a', 'From tab 2b']) {
    await second.keyboard.type(title);
    await second.keyboard.press('Enter');
  }
  await second.keyboard.press('Escape');
  await first.bringToFront();
  await first.getByRole('button', { name: 'Add task' }).first().click();
  await first.keyboard.type('From tab 1');
  await first.keyboard.press('Enter');
  await first.keyboard.press('Escape');

  for (const page of [first, second]) {
    await waitForPending(page, 0);
    await expect
      .poll(() => visibleTitles(page, 'Today'))
      .toEqual(expect.arrayContaining(['From tab 2a', 'From tab 2b', 'From tab 1']));
  }
  const creates = (sent: string[]) => sent.filter((m) => m === `POST /api/v1/orgs/${orgId}/tasks`);
  // Exactly one tab flushed all three.
  expect([creates(sentByFirst).length, creates(sentBySecond).length].sort()).toEqual([0, 3]);
  const list = await myList(first, orgId);
  expect(list.tasks.filter((t) => t.title.startsWith('From tab'))).toHaveLength(3);
});
