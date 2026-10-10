import { signInAs, uniqueEmail } from './support/auth';
import { expect, reload, test } from './support/test';

/**
 * WP 7.4 on phones: the matrix is a stacked list per event (no wide table), each switch a
 * full-width row; push on an iPhone outside the installed app explains "install first".
 */

/** Set to a directory to keep screenshots of the phone layout. */
const shots = process.env.ROOSTER_P7_SCREENSHOTS;

test('the matrix stacks per event, toggles persist, and push explains itself', async ({
  page,
}, testInfo) => {
  await signInAs(page, uniqueEmail('molly.mobile'));
  const list = page.getByTestId('notification-prefs');
  // WebKit may still be finishing the post-sign-in redirect: retry the navigation.
  await expect(async () => {
    await page.goto('/settings/notifications');
    await expect(list).toBeVisible({ timeout: 2_000 });
  }).toPass();
  expect(await list.evaluate((el) => el.tagName)).toBe('UL');
  await expect(page.getByRole('table')).toHaveCount(0);

  // No horizontal scroll at phone width.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  const row = list.getByRole('listitem').filter({ hasText: 'Someone mentions me' });
  const push = row.getByRole('switch', { name: 'Someone mentions me: Push' });
  await expect(push).toBeChecked();
  const saved = page.waitForResponse(
    (r) => r.url().endsWith('/api/v1/me/notification-prefs') && r.request().method() === 'PUT',
  );
  await row.getByText('Push', { exact: true }).tap();
  expect((await saved).status()).toBe(200);
  await expect(push).not.toBeChecked();
  await reload(page);
  await expect(page.getByRole('switch', { name: 'Someone mentions me: Push' })).not.toBeChecked();

  if (shots) {
    await page.screenshot({ path: `${shots}/matrix-${testInfo.project.name}.png` });
  }
  const state = page.getByTestId('push-state');
  await state.scrollIntoViewIfNeeded();
  if (shots) {
    await page.screenshot({ path: `${shots}/push-${testInfo.project.name}.png` });
  }
  if (testInfo.project.name === 'mobile') {
    // iPhone Safari, not installed: push exists only in the Home Screen app.
    await expect(state).toHaveAttribute('data-state', 'ios-install');
    await expect(page.getByText(/push works only in the installed app/)).toBeVisible();
    await page.getByRole('button', { name: 'How to install' }).tap();
    await expect(
      page.getByRole('dialog', { name: 'Add rooster to your Home Screen' }),
    ).toBeVisible();
  } else {
    // Android against `vite` dev: no service worker, so no push here.
    await expect(state).toHaveAttribute('data-state', 'unsupported');
  }
});
