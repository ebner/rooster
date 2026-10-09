import { apiCall, newClient, signInAs, uniqueEmail } from './support/auth';
import { createTask, waitForSync } from './support/p3';
import { expect, test } from './support/test';
import { showKeyboard } from './support/touch';

/**
 * Phase 6 on phones (02 §13.1, §13.4; FR-PWA-5): the Inbox tab in the bottom nav with its live
 * badge, and the comment composer of the detail sheet riding above the keyboard.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      sessionStorage.setItem('e2e-init', '1');
      localStorage.setItem('rooster.locale', 'en');
    }
  });
});

test('the Inbox tab badges live, opens the inbox and the task; the composer sits above the keyboard', async ({
  page,
  browser,
}) => {
  // The phone user owns a shared org; a desktop colleague joins it and assigns a task.
  await signInAs(page, uniqueEmail('petra.phone'));
  const created = await apiCall(page, 'POST', '/api/v1/orgs', { name: 'Garden' });
  const org = (await created.json()) as { id: string; slug: string };
  const invite = await apiCall(page, 'POST', `/api/v1/orgs/${org.slug}/invites`, {
    role: 'member',
  });
  const token = new URL(((await invite.json()) as { url: string }).url).pathname.split('/').at(-1);
  const colleague = await (await newClient(browser)).newPage();
  await signInAs(colleague, uniqueEmail('carl.colleague'));
  await apiCall(colleague, 'POST', `/api/v1/invites/${token}/accept`);
  await apiCall(page, 'POST', '/api/v1/notifications/read', { all: true });
  const meId = ((await (await apiCall(page, 'GET', '/api/v1/me')).json()) as { id: string }).id;

  await page.goto('/o/personal/my');
  const nav = page.getByRole('navigation', { name: 'Primary' });
  const inboxTab = nav.getByTestId('bottom-nav-inbox');
  await expect(nav.getByRole('link')).toHaveText([/My tasks/, /Inbox/, /Settings/]);
  await expect(inboxTab.getByTestId('bottom-nav-badge')).toHaveCount(0);

  const task = await createTask(colleague, org.id, { title: 'Water the tomatoes' });
  await apiCall(colleague, 'PATCH', `/api/v1/tasks/${task.id}`, { assigneeId: meId });
  await expect(inboxTab.getByTestId('bottom-nav-badge')).toHaveText('1');

  await inboxTab.click();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(inboxTab).toHaveAttribute('aria-current', 'page');
  if (process.env.ROOSTER_P6_SCREENSHOTS) {
    await expect(page.getByTestId('notification').first()).toBeVisible();
    await page.screenshot({
      path: `${process.env.ROOSTER_P6_SCREENSHOTS}/inbox-phone-${test.info().project.name}.png`,
    });
  }
  const item = page.getByTestId('notification').first();
  await expect(item).toContainText('assigned a task to you');
  await item.getByRole('button').first().click();
  await expect(page).toHaveURL(new RegExp(`/o/${org.slug}/t/${task.id}$`));
  await expect(page.getByTestId('detail-pane')).toBeVisible();
  await expect(inboxTab.getByTestId('bottom-nav-badge')).toHaveCount(0);

  // The composer sticks above the keyboard (02 §13.4).
  const composer = page.getByTestId('comment-composer');
  await composer.tap();
  await showKeyboard(page, 320);
  const footer = page.getByTestId('pane-composer');
  await expect
    .poll(async () => {
      const box = await footer.boundingBox();
      const height = await page.evaluate(() => window.innerHeight);
      return box ? Math.round(height - (box.y + box.height)) : -1;
    })
    .toBeGreaterThanOrEqual(318);
  if (process.env.ROOSTER_P6_SCREENSHOTS) {
    await composer.fill('Thanks @');
    await page.screenshot({
      path: `${process.env.ROOSTER_P6_SCREENSHOTS}/phone-sheet-keyboard-${test.info().project.name}.png`,
    });
  }
  await composer.fill('Done before the rain');
  await page.getByTestId('comment-post').tap();
  await expect(
    page.getByTestId('comment').filter({ hasText: 'Done before the rain' }),
  ).toBeVisible();
  await waitForSync(page);
});
