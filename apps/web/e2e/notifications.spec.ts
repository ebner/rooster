import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { apiCall, signInAs, uniqueEmail } from './support/auth';
import { e2eEnv } from './support/env';
import { expect, test } from './support/test';

/**
 * Phase 7 settings against the dev server, which runs without SMTP and without a service
 * worker: AC-7.3 (no email options, invites stay copyable links), the preference matrix and
 * the reminder time persisting (WP 7.4), and the admin push-key rotation (WP 7.1).
 */

const wcag = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
/** Set to a directory to keep screenshots of the settings screens. */
const shots = process.env.ROOSTER_P7_SCREENSHOTS;

function prefsSaved(page: Page) {
  return page.waitForResponse(
    (r) => r.url().endsWith('/api/v1/me/notification-prefs') && r.request().method() === 'PUT',
  );
}

test('AC-7.3 without SMTP the matrix has no email column, digest row or email timing', async ({
  page,
}) => {
  await signInAs(page, uniqueEmail('nora.noemail'));
  const meta = (await (await apiCall(page, 'GET', '/api/v1/meta')).json()) as {
    features: { email: boolean; push: boolean };
  };
  // VAPID keys are generated at boot (ADR 0033), so push is always on offer; SMTP is not set.
  expect(meta.features).toMatchObject({ email: false, push: true });
  await page.goto('/settings/notifications');
  const matrix = page.getByTestId('notification-prefs');
  await expect(matrix.getByRole('columnheader')).toHaveText(['Event', 'In app', 'Push']);
  await expect(matrix.getByText('Daily digest')).toHaveCount(0);
  await expect(page.getByRole('switch', { name: /: Email$/ })).toHaveCount(0);
  await expect(page.getByText('Daily digest time')).toHaveCount(0);
  await expect(page.getByRole('radiogroup', { name: 'Notification emails' })).toHaveCount(0);
  await expect(matrix.getByText('Due reminder')).toBeVisible();
  // `vite` dev has no service worker: push cannot be turned on here.
  await expect(page.getByTestId('push-state')).toHaveAttribute('data-state', 'unsupported');
  await expect(
    page.getByText('Push notifications aren’t available in this browser.'),
  ).toBeVisible();
  const results = await new AxeBuilder({ page }).include('main').withTags(wcag).analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' | ')}`),
  ).toEqual([]);
  if (shots) {
    await page.screenshot({ path: `${shots}/settings-notifications-desktop.png`, fullPage: true });
  }
});

test('AC-7.3 without SMTP an email invite shows the copyable link and promises no email', async ({
  page,
}) => {
  await signInAs(page, uniqueEmail('ivan.inviter'));
  const org = (await (await apiCall(page, 'POST', '/api/v1/orgs', { name: 'Choir' })).json()) as {
    slug: string;
  };
  await page.goto(`/o/${org.slug}/settings`);
  await expect(page.getByText(/Until email delivery is set up/)).toBeVisible();
  const created = page.waitForResponse(
    (r) => r.url().endsWith('/invites') && r.request().method() === 'POST',
  );
  await page.getByLabel('Email address').fill('guest@example.com');
  await page.getByRole('button', { name: 'Create invite' }).click();
  const body = (await (await created).json()) as { url: string; emailed?: boolean };
  expect(body.emailed ?? false).toBe(false);
  await expect(page.getByRole('textbox', { name: 'Invite link' })).toHaveValue(body.url);
  await expect(
    page.getByText('Invite for guest@example.com created. Send them this link:'),
  ).toBeVisible();
  await expect(page.getByText(/Invite sent/)).toHaveCount(0);
});

test('WP 7.4 matrix toggles and the reminder time persist across a reload', async ({ page }) => {
  await signInAs(page, uniqueEmail('paula.prefs'));
  await page.goto('/settings/notifications');
  const inapp = page.getByRole('switch', { name: 'Someone mentions me: In app' });
  await expect(inapp).toBeChecked();
  let saved = prefsSaved(page);
  // Keyboard: the switches are focusable and toggle with Space.
  await inapp.focus();
  await page.keyboard.press('Space');
  expect((await saved).status()).toBe(200);
  await expect(inapp).not.toBeChecked();

  const reminder = page.getByRole('switch', { name: 'Due reminder: Push' });
  await expect(reminder).not.toBeChecked();
  saved = prefsSaved(page);
  await reminder.focus();
  await page.keyboard.press('Space');
  expect((await saved).status()).toBe(200);

  const patched = page.waitForResponse(
    (r) => r.url().endsWith('/api/v1/me') && r.request().method() === 'PATCH',
  );
  await page.getByRole('button', { name: /Due reminder time/ }).click();
  await page.getByRole('option', { name: '09:30' }).click();
  expect((await patched).status()).toBe(200);

  await page.reload();
  await expect(page.getByRole('switch', { name: 'Someone mentions me: In app' })).not.toBeChecked();
  await expect(page.getByRole('switch', { name: 'Someone mentions me: Push' })).toBeChecked();
  await expect(page.getByRole('switch', { name: 'Due reminder: Push' })).toBeChecked();
  await expect(page.getByRole('button', { name: /Due reminder time/ })).toContainText('09:30');
  const prefs = (await (await apiCall(page, 'GET', '/api/v1/me/notification-prefs')).json()) as {
    prefs: { type: string; channel: string; enabled: boolean }[];
  };
  expect(prefs.prefs).toContainEqual({ type: 'mention', channel: 'inapp', enabled: false });
});

test('WP 7.3 the digest time and email mode persist on the profile (hidden without SMTP)', async ({
  page,
}) => {
  await signInAs(page, uniqueEmail('dora.digest'));
  const patched = await apiCall(page, 'PATCH', '/api/v1/me', {
    prefs: { digestTime: '06:30', emailMode: 'immediate' },
  });
  expect(patched.status()).toBe(200);
  const me = (await (await apiCall(page, 'GET', '/api/v1/me')).json()) as {
    prefs: { digestTime: string; emailMode: string; reminderTime: string };
  };
  expect(me.prefs).toMatchObject({
    digestTime: '06:30',
    emailMode: 'immediate',
    reminderTime: '08:00',
  });
});

test('WP 7.1 an admin regenerates the push keys after an inline confirmation', async ({ page }) => {
  await signInAs(page, e2eEnv.adminEmail, 'Admin');
  const before = (await (await apiCall(page, 'GET', '/api/v1/push/vapid-public-key')).json()) as {
    publicKey: string;
  };
  await page.goto('/admin');
  const section = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Push keys' }) });
  await section.getByRole('button', { name: 'Regenerate push keys' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(section.getByTestId('push-keys-confirm')).toBeVisible();
  await section.getByRole('button', { name: 'Regenerate keys' }).click();
  await expect(page.getByText('Push keys regenerated')).toBeVisible();
  await expect(section.getByTestId('push-keys-confirm')).toHaveCount(0);
  const after = (await (await apiCall(page, 'GET', '/api/v1/push/vapid-public-key')).json()) as {
    publicKey: string;
  };
  expect(after.publicKey).not.toBe(before.publicKey);
});
