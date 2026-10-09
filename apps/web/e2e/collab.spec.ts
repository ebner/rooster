import AxeBuilder from '@axe-core/playwright';
import type { Browser, Page } from '@playwright/test';
import type { ActivityPage, Task } from '@rooster/core/schemas';
import { apiCall, displayNameOf, newClient, signInAs, uniqueEmail } from './support/auth';
import { createTask, mod, personalOrg, waitForSync } from './support/p3';
import { expect, test } from './support/test';

/** Phase 6 comments, mentions and the inbox (WP 6.3–6.5; AC-6.1, AC-6.3). */

/** Set to a directory to save the review screenshots (pane light and dark, inbox, kitchen sink). */
const shots = process.env.ROOSTER_P6_SCREENSHOTS;
const wcag = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      sessionStorage.setItem('e2e-init', '1');
      localStorage.setItem('rooster.locale', 'en');
    }
  });
});

interface Shared {
  a: Page;
  b: Page;
  orgId: string;
  slug: string;
  bId: string;
  aName: string;
  bName: string;
}

async function userId(page: Page): Promise<string> {
  return ((await (await apiCall(page, 'GET', '/api/v1/me')).json()) as { id: string }).id;
}

/** A signs in and creates an org; B signs in and joins it through an invite link. */
async function sharedOrg(browser: Browser, name: string): Promise<Shared> {
  const a = await (await newClient(browser)).newPage();
  const aEmail = uniqueEmail('anna.author');
  await signInAs(a, aEmail);
  const created = await apiCall(a, 'POST', '/api/v1/orgs', { name });
  const org = (await created.json()) as { id: string; slug: string };
  const invite = await apiCall(a, 'POST', `/api/v1/orgs/${org.slug}/invites`, { role: 'member' });
  const { url } = (await invite.json()) as { url: string };
  const token = new URL(url).pathname.split('/').at(-1) ?? '';

  const b = await (await newClient(browser)).newPage();
  const bEmail = uniqueEmail('bert.buddy');
  await signInAs(b, bEmail);
  const accepted = await apiCall(b, 'POST', `/api/v1/invites/${token}/accept`);
  expect(accepted.status(), await accepted.text()).toBe(200);
  // Reload so B's sidebar knows the new org.
  await b.reload();
  // The inviter hears that B joined (FR-NOT-1); clear it so the badges start at zero.
  const inbox = (await (await apiCall(a, 'GET', '/api/v1/notifications')).json()) as {
    items: { type: string }[];
  };
  expect(inbox.items.map((n) => n.type)).toContain('invite_accepted');
  await apiCall(a, 'POST', '/api/v1/notifications/read', { all: true });
  return {
    a,
    b,
    orgId: org.id,
    slug: org.slug,
    bId: await userId(b),
    aName: displayNameOf(aEmail),
    bName: displayNameOf(bEmail),
  };
}

const inboxItem = (page: Page) => page.getByTestId('sidebar-inbox');
const composer = (page: Page) => page.getByTestId('comment-composer');

async function feed(page: Page, taskId: string): Promise<ActivityPage> {
  return (await (
    await apiCall(page, 'GET', `/api/v1/tasks/${taskId}/activity`)
  ).json()) as ActivityPage;
}

test('AC-6.3 a mention notifies B live; B opens it from the inbox and now follows', async ({
  browser,
}) => {
  const { a, b, orgId, slug, bId, aName, bName } = await sharedOrg(browser, 'Studio');
  const task = await createTask(a, orgId, { title: 'Plan the launch' });

  await expect(inboxItem(b)).toHaveText('Inbox');
  await a.goto(`/o/${slug}/t/${task.id}`);
  await expect(a.getByTestId('detail-pane')).toBeVisible();
  // Followers and the assignee show in a shared org (FR-COL-6).
  await expect(a.getByTestId('follow-toggle')).toHaveAttribute('aria-pressed', 'true');

  await composer(a).click();
  await composer(a).pressSequentially('Hey @ber');
  const suggestions = a.getByTestId('mention-suggestions');
  await expect(suggestions.getByRole('option').first()).toContainText(bName);
  await composer(a).press('Enter');
  await expect(composer(a)).toHaveValue(`Hey @[${bName}](user:${bId}) `);
  await composer(a).pressSequentially('can you check?');
  await composer(a).press(`${mod}+Enter`);
  await expect(composer(a)).toHaveValue('');

  const comment = a.getByTestId('comment').filter({ hasText: 'can you check?' });
  await expect(comment.locator(`[data-mention="${bId}"]`)).toHaveText(`@${bName}`);
  await waitForSync(a);

  // B's badge counts it live (SSE), the author's does not (actor exclusion).
  await expect(inboxItem(b)).toContainText('1 unread');
  await expect(inboxItem(a)).toHaveText('Inbox');

  await inboxItem(b).click();
  await expect(b).toHaveURL(/\/inbox$/);
  const notification = b.getByTestId('notification').first();
  await expect(notification).toContainText(`${aName} mentioned you`);
  await expect(notification).toContainText('Plan the launch');
  await notification.getByRole('button').first().click();
  await expect(b).toHaveURL(new RegExp(`/o/${slug}/t/${task.id}$`));
  await expect(b.getByTestId('comment').filter({ hasText: 'can you check?' })).toBeVisible();
  await expect(inboxItem(b)).toHaveText('Inbox');
  if (shots) {
    await b.setViewportSize({ width: 1440, height: 900 });
    await b.screenshot({ path: `${shots}/pane-desktop-light.png` });
    await b.emulateMedia({ colorScheme: 'dark' });
    await b.screenshot({ path: `${shots}/pane-desktop-dark.png` });
    await b.emulateMedia({ colorScheme: 'light' });
    await b.goto('/inbox');
    await expect(b.getByTestId('notification').first()).toBeVisible();
    await b.screenshot({ path: `${shots}/inbox-desktop.png` });
    await b.goBack();
  }

  // AC-6.3: the mention made B a follower.
  const detail = (await (await apiCall(b, 'GET', `/api/v1/tasks/${task.id}`)).json()) as {
    followers: string[];
  };
  expect(detail.followers).toContain(bId);
  await expect(b.getByTestId('follow-toggle')).toHaveAttribute('aria-pressed', 'true');
});

test('AC-6.1 assigning to B notifies B, not A', async ({ browser }) => {
  const { a, b, orgId, bId } = await sharedOrg(browser, 'Atelier');
  await a.goto('/o/personal/my');
  await expect(inboxItem(b)).toHaveText('Inbox');
  const task = await createTask(a, orgId, { title: 'Order paint' });
  const patched = await apiCall(a, 'PATCH', `/api/v1/tasks/${task.id}`, { assigneeId: bId });
  expect(patched.status(), await patched.text()).toBe(200);
  await expect(inboxItem(b)).toContainText('1 unread');
  await expect(inboxItem(a)).toHaveText('Inbox');

  // Unread filter, mark read (U) and unread again from the keyboard.
  await inboxItem(b).click();
  const item = b.getByTestId('notification').first();
  await expect(item).toContainText('assigned a task to you');
  await b.keyboard.press('j');
  await b.keyboard.press('u');
  await expect(item).not.toHaveAttribute('data-unread', 'true');
  await expect(inboxItem(b)).toHaveText('Inbox');
  await b.keyboard.press('u');
  await expect(item).toHaveAttribute('data-unread', 'true');
  await expect(inboxItem(b)).toContainText('1 unread');
  await b.getByTestId('mark-all-read').click();
  await expect(inboxItem(b)).toHaveText('Inbox');
});

test('own comments are edited inline and deleted with undo', async ({ page }) => {
  await signInAs(page, uniqueEmail('erik.editor'));
  const orgId = await personalOrg(page);
  const task: Task = await createTask(page, orgId, { title: 'Write notes' });
  await page.goto(`/o/personal/t/${task.id}`);
  // Personal orgs show comments, never followers (FR-COL-6).
  await expect(page.getByTestId('follow-toggle')).toHaveCount(0);

  await composer(page).fill('First **draft**');
  await composer(page).press(`${mod}+Enter`);
  const first = page.getByTestId('comment').filter({ hasText: 'First' });
  await expect(first.locator('strong')).toHaveText('draft');
  const commentId = await first.getAttribute('data-comment-id');
  const comment = page.locator(`[data-comment-id="${commentId}"]`);
  await waitForSync(page);

  await comment.hover();
  await comment.getByTestId('comment-menu').click();
  await page.getByRole('menuitem', { name: 'Edit comment' }).click();
  const editor = comment.getByRole('textbox', { name: 'Edit comment' });
  await editor.fill('Second version');
  await editor.press(`${mod}+Enter`);
  const edited = page.getByTestId('comment').filter({ hasText: 'Second version' });
  await expect(edited.getByTestId('comment-edited')).toBeVisible();
  await waitForSync(page);

  await edited.hover();
  await edited.getByTestId('comment-menu').click();
  await page.getByRole('menuitem', { name: 'Delete comment' }).click();
  await expect(page.getByTestId('comment')).toHaveCount(0);
  await waitForSync(page);
  expect((await feed(page, task.id)).items.some((i) => i.kind === 'comment')).toBe(false);

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByTestId('comment').filter({ hasText: 'Second version' })).toBeVisible();
  await waitForSync(page);
  const items = (await feed(page, task.id)).items;
  expect(items.filter((i) => i.kind === 'comment')).toHaveLength(1);
});

test('a comment written offline shows at once and syncs when back online', async ({
  page,
  context,
}) => {
  await signInAs(page, uniqueEmail('olga.offline'));
  const orgId = await personalOrg(page);
  const task = await createTask(page, orgId, { title: 'Field trip' });
  await page.goto(`/o/personal/t/${task.id}`);
  await expect(page.getByTestId('activity-feed')).toBeVisible();

  await context.setOffline(true);
  // Tab+Enter posts too (the composer re-targets the pane's chord).
  await composer(page).fill('Written on the train');
  await page.keyboard.down('Tab');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Tab');
  await expect(composer(page)).toHaveValue('');
  await expect(composer(page)).toBeFocused();
  const comment = page.getByTestId('comment').filter({ hasText: 'Written on the train' });
  await expect(comment).toHaveAttribute('data-pending', 'true');
  await expect(comment).toContainText('Sending…');

  await context.setOffline(false);
  await expect(comment).not.toHaveAttribute('data-pending', 'true');
  await waitForSync(page);
  const items = (await feed(page, task.id)).items;
  expect(items.some((i) => i.kind === 'comment' && i.comment.body === 'Written on the train')).toBe(
    true,
  );
});

test('the kitchen sink shows the collaboration pieces, axe-clean', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/_dev/ui');
  const section = page.getByTestId('section-collab');
  await section.scrollIntoViewIfNeeded();
  await expect(section.getByTestId('activity-feed').first()).toBeVisible();
  await expect(section.getByTestId('mention-suggestions')).toBeVisible();
  await expect(section.getByTestId('notification')).toHaveCount(6);
  const results = await new AxeBuilder({ page }).include('#collab').withTags(wcag).analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' | ')}`),
  ).toEqual([]);
  if (shots) await section.screenshot({ path: `${shots}/kitchen-sink-collab.png` });
});
