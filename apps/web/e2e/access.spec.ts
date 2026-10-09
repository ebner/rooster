import type { APIRequestContext, Page } from '@playwright/test';
import { apiCall, signInAs, uniqueEmail } from './support/auth';
import { groupId, personalOrg } from './support/p3';
import { expect, test } from './support/test';

/**
 * WP 8.2 (11 §3.2): Settings → Connected apps. A token made in the UI, limited to writing in
 * Prio, is held to that by the API (AC-8.5, UI path); narrowing applies to the next request;
 * revoking fails the next call with 401.
 */

const shots = process.env.ROOSTER_P8_SCREENSHOTS;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      sessionStorage.setItem('e2e-init', '1');
      localStorage.setItem('rooster.locale', 'en');
    }
  });
});

function withToken(request: APIRequestContext, token: string) {
  return (method: 'GET' | 'POST', path: string, data?: unknown) =>
    request.fetch(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(data === undefined ? {} : { data }),
    });
}

async function grants(page: Page) {
  const res = await apiCall(page, 'GET', '/api/v1/me/grants');
  expect(res.status()).toBe(200);
  return (await res.json()) as {
    id: string;
    label: string;
    scopes: string[];
    constraints: unknown;
  }[];
}

test('AC-8.5 (UI) a token limited to Prio: 403 outside_grant elsewhere, narrowing and revoking apply at once', async ({
  page,
  request,
}) => {
  await signInAs(page, uniqueEmail('pat.owner'));
  const orgId = await personalOrg(page);
  const prio = await groupId(page, orgId, 'Prio');
  const today = await groupId(page, orgId, 'Today');

  await page.goto('/settings/security');
  const section = page.locator('#connected-apps');
  await expect(section.getByRole('heading', { name: 'Connected apps' })).toBeVisible();
  await section.getByTestId('new-token').click();
  const form = section.getByTestId('new-token-form');
  await form.getByRole('textbox', { name: 'Name' }).fill('Prio writer');
  // Writing starts in the personal Inbox (11 §3.1); move it to Prio with the keyboard.
  // Keyboard: the checkboxes are focusable and toggle with Space.
  await form.getByRole('checkbox', { name: /Add and change tasks/ }).focus();
  await page.keyboard.press('Space');
  const picker = form.getByRole('listbox', { name: /Groups it may change in/ });
  await expect(picker.getByRole('option', { name: 'Inbox' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await picker.getByRole('option', { name: 'Inbox' }).focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await expect(picker.getByRole('option', { name: 'Prio' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(form.getByTestId('grant-summary')).toContainText(
    'can add and change tasks only in Personal › Prio',
  );
  if (shots)
    await page.screenshot({
      path: `${shots}/token-form.png`,
      fullPage: true,
      animations: 'disabled',
    });
  await form.getByRole('button', { name: 'Create token' }).click();

  const reveal = section.getByTestId('token-reveal');
  await expect(reveal).toContainText('You won’t be able to see it again');
  const token = await reveal.getByTestId('token-value').inputValue();
  expect(token).toMatch(/^rooster_pat_/);
  if (shots)
    await page.screenshot({
      path: `${shots}/token-once.png`,
      fullPage: true,
      animations: 'disabled',
    });
  await reveal.getByRole('button', { name: 'Done' }).click();
  await expect(section.getByTestId('token-reveal')).toHaveCount(0);
  await expect(page.getByText(token)).toHaveCount(0);

  const [grant] = (await grants(page)).filter((g) => g.label === 'Prio writer');
  expect(grant?.scopes).toEqual(['tasks:write']);
  expect(grant?.constraints).toEqual({
    orgs: [{ orgId, read: 'all', write: { groups: [prio] } }],
  });

  const call = withToken(request, token);
  const created = await call('POST', `/api/v1/orgs/${orgId}/tasks`, {
    title: 'Via token',
    groupId: prio,
  });
  expect(created.status(), await created.text()).toBe(201);
  const task = (await created.json()) as { id: string };
  const done = await call('POST', `/api/v1/tasks/${task.id}/complete`, { completed: true });
  expect(done.status(), await done.text()).toBeLessThan(300);
  const outside = await call('POST', `/api/v1/orgs/${orgId}/tasks`, {
    title: 'Not here',
    groupId: today,
  });
  expect(outside.status()).toBe(403);
  expect(await outside.json()).toMatchObject({ code: 'outside_grant' });

  // Narrowing in Settings applies to the very next request.
  await page.reload();
  const row = page.locator('#connected-apps').getByTestId(`grant-${grant?.id}`);
  await expect(row).toContainText('can add and change tasks only in Personal › Prio');
  await row.getByRole('button', { name: 'Edit Prio writer' }).click();
  const edit = row.getByTestId('edit-grant');
  await edit.getByTestId(`write-${orgId}`).getByText('Nothing', { exact: true }).click();
  const patched = page.waitForResponse(
    (r) => r.url().endsWith(`/api/v1/me/grants/${grant?.id}`) && r.request().method() === 'PATCH',
  );
  await edit.getByRole('button', { name: 'Save changes' }).click();
  // Saving re-confirms the grant's orgs and groups first, then sends the PATCH.
  expect((await patched).ok()).toBe(true);
  await expect(row.getByTestId('edit-grant')).toHaveCount(0);
  await expect(row).toContainText('can’t change anything');
  const narrowed = await call('POST', `/api/v1/orgs/${orgId}/tasks`, {
    title: 'Not anymore',
    groupId: prio,
  });
  expect(narrowed.status()).toBe(403);
  expect((await call('GET', `/api/v1/orgs/${orgId}/my-list`)).status()).toBe(200);

  // Revoke with the inline confirm: the next call is 401.
  await row.getByRole('button', { name: 'Revoke Prio writer' }).click();
  await row.getByTestId('confirm-revoke').click();
  await expect(page.locator('#connected-apps').getByTestId(`grant-${grant?.id}`)).toHaveCount(0);
  expect((await call('GET', '/api/v1/me')).status()).toBe(401);
});
