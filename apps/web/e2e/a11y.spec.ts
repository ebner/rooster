import type { Page } from '@playwright/test';
import { expectAxeClean, seedA11yList } from './support/a11y';
import { apiCall, newClient, signInAs, uniqueEmail } from './support/auth';
import { e2eEnv } from './support/env';
import { mod } from './support/p3';
import { expect, test } from './support/test';

/**
 * WP 11.3, AC-11.3: axe reports no WCAG 2.2 AA violation on any screen, on desktop (this file) and on phones (`a11y.mobile.spec.ts`).
 */

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      sessionStorage.setItem('e2e-init', '1');
      localStorage.setItem('rooster.locale', 'en');
    }
  });
});

const row = (page: Page, title: string) =>
  page
    .getByTestId('task-row')
    .filter({ has: page.locator('[data-focus-target]').getByText(title, { exact: true }) });

async function focusRow(page: Page, title: string) {
  await row(page, title).locator('[data-focus-target]').focus();
}

test('AC-11.3 axe: sign-in and the signed-out pages', async ({ browser }) => {
  const context = await newClient(browser, { viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'Continue with Dev login' })).toBeVisible();
  await expectAxeClean(page, 'login');
  await page.goto('/not-invited');
  await expect(page.getByRole('main')).toBeVisible();
  await expectAxeClean(page, 'not invited');
  await context.close();
});

test('AC-11.3 axe: My tasks, the smart views, the pane and the list popovers', async ({ page }) => {
  test.setTimeout(180_000);
  await signInAs(page, uniqueEmail('a11y.list'));
  const seed = await seedA11yList(page);
  const base = `/o/${seed.slug}`;
  await page.goto(`${base}/my`);
  await expect(row(page, 'Step 5')).toBeVisible();
  await expect(row(page, 'Book dentist').getByTestId('repeat-indicator')).toBeVisible();
  await expect(row(page, 'Book dentist').getByTestId('reminder-indicator')).toBeVisible();
  await expectAxeClean(page, 'my tasks');

  for (const view of ['today', 'week', 'overdue', 'nodate'] as const) {
    await page.goto(`${base}/${view}`);
    await expect(page.getByRole('treegrid').or(page.getByTestId('view-empty'))).toBeVisible();
    await expectAxeClean(page, `smart view ${view}`);
  }

  // The pane, with description, subtasks, comments, activity and attachments.
  await page.goto(`${base}/t/${seed.dentist.id}`);
  const pane = page.getByTestId('detail-pane');
  await expect(pane).toBeVisible();
  await expect(pane.getByText('referral.txt').first()).toBeVisible();
  await expect(pane.getByText('no answer')).toBeVisible();
  await expectAxeClean(page, 'task pane');

  // The list popovers, opened from the keyboard.
  await page.goto(`${base}/my`);
  await focusRow(page, 'Book dentist');
  await page.keyboard.press('d');
  const date = page.getByRole('dialog', { name: 'Due date' });
  await expect(date).toBeVisible();
  // A pending reminder opens the section by itself, but its content is a lazy chunk that renders
  // nothing while it loads: wait for the section or the closed state's toggle, never press Alt+R
  // into a section that is still loading (it would close it again).
  const reminderSection = date.getByTestId('reminder-section');
  const reminderToggle = date.locator('[aria-keyshortcuts="Alt+R"]');
  await expect(reminderSection.or(reminderToggle).first()).toBeVisible();
  if (await reminderToggle.isVisible()) await page.keyboard.press('Alt+r');
  await expect(reminderSection).toBeVisible();
  await expect(
    date.getByRole('button', { name: 'Repeat' }).or(date.getByTestId('repeat-section')).first(),
  ).toBeVisible();
  await expectAxeClean(page, 'date popover with Repeat and Reminders');
  await page.keyboard.press('Escape');
  await expect(date).toHaveCount(0);

  await focusRow(page, 'Book dentist');
  await page.keyboard.press('t');
  await expect(page.getByRole('dialog', { name: /tags/i })).toBeVisible();
  await expectAxeClean(page, 'tag picker');
  await page.keyboard.press('Escape');

  await focusRow(page, 'Book dentist');
  await page.keyboard.press('m');
  await expect(page.getByRole('dialog', { name: 'Move task to' })).toBeVisible();
  await expectAxeClean(page, 'move menu');
  await page.keyboard.press('Escape');

  await focusRow(page, 'Book dentist');
  await page.keyboard.press(`${mod}+k`);
  const palette = page.getByTestId('palette');
  await expect(palette).toBeVisible();
  await page.keyboard.type('dent');
  await expect(palette.getByRole('option').first()).toBeVisible();
  await expectAxeClean(page, 'palette');
  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);

  await focusRow(page, 'Book dentist');
  await page.keyboard.press('?');
  await expect(page.getByRole('complementary', { name: 'Keyboard shortcuts' })).toBeVisible();
  await expectAxeClean(page, 'cheat sheet');
});

test('AC-11.3 axe: Everyone’s tasks, the inbox, every settings page and org settings', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signInAs(page, uniqueEmail('a11y.settings'));
  const created = await apiCall(page, 'POST', '/api/v1/orgs', { name: 'Harbour' });
  const org = (await created.json()) as { id: string; slug: string };
  await apiCall(page, 'POST', `/api/v1/orgs/${org.id}/tasks`, { title: 'Fix the jetty' });
  await page.goto(`/o/${org.slug}/everyone`);
  await expect(row(page, 'Fix the jetty')).toBeVisible();
  await expectAxeClean(page, 'everyone');

  await page.goto(`/o/${org.slug}/settings`);
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expectAxeClean(page, 'org settings');

  await page.goto('/inbox');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expectAxeClean(page, 'inbox');

  for (const section of ['profile', 'behaviour', 'notifications', 'calendar', 'data', 'security']) {
    await page.goto(`/settings/${section}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // Settings sections load their data; wait for the spinners to go.
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    await expectAxeClean(page, `settings ${section}`);
  }
});

test('AC-11.3 axe: admin, as an instance admin', async ({ page }) => {
  await signInAs(page, e2eEnv.adminEmail, 'Admin');
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Backups' })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await expectAxeClean(page, 'admin');
});

test('AC-11.3 axe: the device approval and OAuth consent pages', async ({ page, request }) => {
  const codeRes = await request.post('/api/auth/device/code', {
    form: { client_id: 'rooster-cli', scope: 'tasks:delete comments:write groups:write' },
  });
  expect(codeRes.status(), await codeRes.text()).toBe(200);
  const code = (await codeRes.json()) as { verification_uri_complete: string; user_code: string };
  const verify = new URL(code.verification_uri_complete);
  await signInAs(page, uniqueEmail('a11y.device'), undefined, {
    startAt: verify.pathname + verify.search,
    landing: /\/device\?user_code=/,
  });
  await expect(page.getByTestId('device-code-form')).toBeVisible();
  await expectAxeClean(page, 'device code');
  await page.getByRole('textbox', { name: 'Code' }).fill(code.user_code);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('device-request')).toBeVisible();
  await expectAxeClean(page, 'device approval');

  // An app on this computer asks for access (DCR: e2e can't serve a CIMD document).
  const redirectUri = `http://127.0.0.1:${40_000 + Math.floor(Math.random() * 20_000)}/callback`;
  const reg = await request.post('/api/auth/oauth2/register', {
    data: {
      client_name: 'A11y Agent',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      application_type: 'native',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
  });
  expect(reg.status(), await reg.text()).toBeLessThan(300);
  const clientId = ((await reg.json()) as { client_id: string }).client_id;
  const origin = new URL(page.url()).origin;
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
    scope: 'tasks:read tasks:write offline_access',
    resource: `${origin}/mcp`,
    state: 'a11y',
  });
  await page.goto(`/api/auth/oauth2/authorize?${query}`);
  await page.waitForURL(/\/oauth\/consent\?/);
  await expect(page.getByTestId('consent-request')).toBeVisible();
  await expectAxeClean(page, 'oauth consent');
});
