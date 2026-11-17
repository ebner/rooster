import type { Browser, Page } from '@playwright/test';
import type { Task } from '@rooster/core/schemas';
import { apiCall, displayNameOf, newClient, signInAs, uniqueEmail } from './support/auth';
import { createTask, personalOrg, waitForSync } from './support/p3';
import { sharedOrg } from './support/p6-people';
import { expect, test } from './support/test';

/** ADR 0072: moving a task to another organisation from the detail pane (desktop). */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      sessionStorage.setItem('e2e-init', '1');
      localStorage.setItem('rooster.locale', 'en');
    }
  });
});

async function task(page: Page, id: string): Promise<Task> {
  return (await (await apiCall(page, 'GET', `/api/v1/tasks/${id}`)).json()) as Task;
}

/** The pane's ⋯ → "Move to organisation…", then the org. */
async function openPicker(page: Page, org: string) {
  const toolbar = page.getByRole('toolbar', { name: 'Task actions' });
  await toolbar.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Move to organisation…' }).click();
  const picker = page.getByTestId('move-org-popover');
  await expect(picker.getByRole('listbox', { name: 'Organisations' })).toBeVisible();
  await picker.getByRole('option', { name: org }).click();
  await expect(picker.getByRole('listbox', { name: `Groups in ${org}` })).toBeVisible();
  return picker;
}

/** A third person joins `orgSlug` through an invite link. */
async function join(browser: Browser, page: Page, orgSlug: string, email: string) {
  const invite = await apiCall(page, 'POST', `/api/v1/orgs/${orgSlug}/invites`, {
    role: 'member',
  });
  const invitePath = new URL(((await invite.json()) as { url: string }).url).pathname;
  const context = await newClient(browser);
  await context.addInitScript(() => localStorage.setItem('rooster.locale', 'en'));
  const other = await context.newPage();
  await signInAs(other, email, displayNameOf(email), {
    startAt: invitePath,
    button: 'Accept and sign in with Dev login',
    landing: new RegExp(`/o/${orgSlug}/my$`),
  });
  return other;
}

test('ADR 0072 a task moves from Personal to a shared org’s group with a new number; undo brings it back', async ({
  page,
  browser,
}) => {
  const { a, slug, orgId } = await sharedOrg(page, browser, 'move.org');
  const personal = await personalOrg(a);
  // Two tasks in Harbour first, so the moved one gets a number of its own there.
  await createTask(a, orgId, { title: 'Harbour one' });
  await createTask(a, orgId, { title: 'Harbour two' });
  const moving = await createTask(a, personal, { title: 'Call the bank' });
  const before = await task(a, moving.id);

  await a.goto(`/o/personal/t/${moving.id}`);
  await expect(a.getByTestId('detail-pane')).toBeVisible();
  const picker = await openPicker(a, 'Harbour');
  // Enter takes the first normal group (the default).
  await picker.getByRole('combobox').press('Enter');

  await expect(a.getByText('Moved to Harbour')).toBeVisible();
  await expect(a).toHaveURL(new RegExp(`/o/${slug}/t/${moving.id}$`));
  await waitForSync(a);
  const moved = await task(a, moving.id);
  expect(moved.orgId).toBe(orgId);
  expect(moved.seq).not.toBe(before.seq);
  expect(moved.seq).toBe(3);
  await expect(a.getByTestId('detail-pane')).toContainText('Call the bank');
  await expect(
    a.getByTestId('task-row').filter({ hasText: 'Call the bank' }).first(),
  ).toBeVisible();

  // Undo (Ctrl/⌘+Z works anywhere): back in Personal, with its old number.
  await a.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await waitForSync(a);
  await expect.poll(async () => (await task(a, moving.id)).orgId).toBe(personal);
  expect((await task(a, moving.id)).seq).toBe(before.seq);
  // ADR 0072 §23: the pane follows the task home.
  await expect(a).toHaveURL(new RegExp(`/o/personal/t/${moving.id}$`));
});

test('ADR 0072 §13 moving other people’s comments to new people asks first', async ({
  page,
  browser,
}) => {
  const { a, b, slug, orgId } = await sharedOrg(page, browser, 'move.confirm');
  const plan = await createTask(a, orgId, { title: 'Plan the picnic' });
  const comment = await apiCall(b, 'POST', `/api/v1/tasks/${plan.id}/comments`, {
    body: 'Bring the blue blanket',
  });
  expect(comment.status()).toBe(201);
  // Cove: A and someone who isn't in Harbour.
  const cove = (await (await apiCall(a, 'POST', '/api/v1/orgs', { name: 'Cove' })).json()) as {
    id: string;
    slug: string;
  };
  await join(browser, a, cove.slug, uniqueEmail('move.confirm.cecilia'));

  await a.goto(`/o/${slug}/t/${plan.id}`);
  await expect(a.getByTestId('detail-pane')).toBeVisible();
  const picker = await openPicker(a, 'Cove');
  await picker.getByRole('combobox').press('Enter');
  const confirm = picker.getByTestId('move-org-confirm');
  await expect(confirm).toContainText(
    '1 comment by other people will be visible to members of Cove.',
  );
  await confirm.getByRole('button', { name: 'Move' }).click();
  await expect(a).toHaveURL(new RegExp(`/o/${cove.slug}/t/${plan.id}$`));
  await waitForSync(a);
  expect((await task(a, plan.id)).orgId).toBe(cove.id);
});
