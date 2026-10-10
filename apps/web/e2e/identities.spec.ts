import type { Browser, BrowserContext, Page } from '@playwright/test';
import { newClient, signInAs, uniqueEmail, useIdentity } from './support/auth';
import { expect, test } from './support/test';

/**
 * FR-SET-3: an unlinked sign-in identity stays blocked until the user allows it again. Without
 * the block, an email authority (here Corp SSO, `trustEmail`) would link it again by email on
 * its next sign-in.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      sessionStorage.setItem('e2e-init', '1');
      localStorage.setItem('rooster.locale', 'en');
    }
  });
});

/** A signed-out browser that signs in as `email` through Corp SSO. */
async function corpClient(
  browser: Browser,
  email: string,
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await newClient(browser);
  await ctx.addInitScript(() => localStorage.setItem('rooster.locale', 'en'));
  await useIdentity(ctx, email);
  return { ctx, page: await ctx.newPage() };
}

async function continueWithCorp(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with Corp SSO' }).click();
}

test('FR-SET-3 a removed sign-in is refused until it is allowed again', async ({
  page,
  browser,
}) => {
  const email = uniqueEmail('identities.two');
  await signInAs(page, email);

  // Corp SSO links to the account by email.
  const first = await corpClient(browser, email);
  await continueWithCorp(first.page);
  await first.page.waitForURL(/\/o\/[^/]+\/my$/);
  await first.ctx.close();

  await page.goto('/settings/security');
  const linked = page.getByTestId('linked-identities');
  await expect(linked.getByRole('listitem')).toHaveCount(2);
  await linked.getByRole('button', { name: /^Unlink Corp SSO/ }).click();
  await expect(page.getByText(/can’t sign in with it until you allow it again/)).toBeVisible();
  await page.getByTestId('confirm-unlink').click();
  await expect(linked.getByRole('listitem')).toHaveCount(1);
  const removed = page.getByTestId('removed-identities');
  await expect(page.getByRole('heading', { name: 'Removed sign-ins' })).toBeVisible();
  await expect(removed).toContainText('Corp SSO');
  await expect(removed).toContainText(email);

  // Signing in through it now ends on the login page with the explanation, signed out.
  const attempt = await corpClient(browser, email);
  await continueWithCorp(attempt.page);
  await attempt.page.waitForURL(/\/login\?error=identity_unlinked$/);
  await expect(attempt.page.getByRole('alert')).toContainText('This sign-in was removed');
  await expect(attempt.page.getByRole('alert')).toContainText('allow it in Settings → Security');
  expect((await attempt.page.request.get('/api/v1/me')).status()).toBe(401);

  // Allowed again (inline confirm), the next sign-in through it links as before.
  await removed.getByRole('button', { name: /^Allow Corp SSO .* again$/ }).click();
  await page.getByTestId('confirm-allow').click();
  await expect(page.getByText('Sign-in allowed again')).toBeVisible();
  await expect(page.getByTestId('removed-identities')).toHaveCount(0);

  await continueWithCorp(attempt.page);
  await attempt.page.waitForURL(/\/o\/[^/]+\/my$/);
  await attempt.ctx.close();
  await page.reload();
  await expect(page.getByTestId('linked-identities').getByRole('listitem')).toHaveCount(2);
});
