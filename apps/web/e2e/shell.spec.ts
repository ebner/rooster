import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { apiCall, displayNameOf, newClient, signInAs, uniqueEmail } from './support/auth';
import { e2eEnv } from './support/env';
import { expect, test } from './support/test';

/**
 * The signed-in shell and Phase 1 screens on the real server: layout per 02 §2,
 * axe (WCAG 2.2 AA), and screenshots. Set ROOSTER_SCREENSHOT_DIR to keep them for
 * design review; otherwise they go to the test output.
 */
const wcag = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      sessionStorage.setItem('e2e-init', '1');
      localStorage.setItem('rooster.locale', 'en');
      localStorage.removeItem('rooster.sidebar.collapsed');
    }
  });
});

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(wcag).analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' | ')}`),
  ).toEqual([]);
}

function screenshotPath(name: string, outputPath: (name: string) => string): string {
  const dir = process.env.ROOSTER_SCREENSHOT_DIR;
  return dir ? `${dir}/${name}.png` : outputPath(`${name}.png`);
}

/** A signed-in owner of "Northwind" (plus the personal org). */
async function signInWithSharedOrg(page: Page, name = 'hanna.shell'): Promise<string> {
  await signInAs(page, uniqueEmail(name));
  const res = await apiCall(page, 'POST', '/api/v1/orgs', { name: 'Northwind' });
  expect(res.status()).toBe(201);
  const { slug } = (await res.json()) as { slug: string };
  await page.reload();
  return slug;
}

for (const width of [1440, 390] as const) {
  test(`shell at ${width} px renders the sidebar per 02 §2 and is axe-clean`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
    await signInWithSharedOrg(page, `wide${width}.user`);
    await expect(page.getByRole('heading', { level: 1, name: /My tasks/ })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Today' })).toBeVisible();
    await page.screenshot({
      path: screenshotPath(`real-shell-${width}`, (n) => testInfo.outputPath(n)),
    });
    if (width < 768) {
      // 02 §13.1: no sidebar on phones; the org switcher sheet and the bottom nav replace it.
      await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
      await expect(
        page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'My tasks' }),
      ).toHaveAttribute('aria-current', 'page');
      await page.getByTestId('org-switcher').click();
      const sheet = page.getByRole('dialog', { name: 'Organisations' });
      await expect(sheet.getByRole('button', { name: 'Personal' })).toBeVisible();
      await expect(sheet.getByRole('button', { name: 'Northwind' })).toBeVisible();
      await page.waitForTimeout(300);
      await page.screenshot({
        path: screenshotPath(`real-orgs-${width}`, (n) => testInfo.outputPath(n)),
      });
      await expectNoAxeViolations(page);
      return;
    }
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('region', { name: 'Personal' })).toBeVisible();
    await expect(nav.getByRole('region', { name: 'Northwind' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'My tasks' }).first()).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expectNoAxeViolations(page);
  });
}

test('rail state survives a reload (Ctrl+\\)', async ({ page }) => {
  await signInAs(page, uniqueEmail('rail.keeper'));
  await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible();
  await page.keyboard.press('Control+Backslash');
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
});

test('the new-organisation popover is axe-clean', async ({ page }) => {
  await signInAs(page, uniqueEmail('popo.ver'));
  await page.getByRole('button', { name: 'New organisation' }).click();
  const dialog = page.getByRole('dialog', { name: 'New organisation' });
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Garden club');
  await dialog.getByRole('option', { name: '🌱' }).click();
  await expectNoAxeViolations(page);
  await dialog.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/o\/garden-club[^/]*\/my$/);
  await expect(page.getByRole('heading', { level: 1, name: /Garden club/ })).toBeVisible();
});

test('org settings, profile and security are axe-clean', async ({ page }, testInfo) => {
  const slug = await signInWithSharedOrg(page, 'axe.owner');
  for (const [path, shot] of [
    [`/o/${slug}/settings`, 'real-org-settings-1440'],
    ['/o/personal/settings', 'real-org-settings-personal-1440'],
    ['/settings/profile', 'real-profile-1440'],
    ['/settings/security', 'real-security-1440'],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
    await page.screenshot({ path: screenshotPath(shot, (n) => testInfo.outputPath(n)) });
    await expectNoAxeViolations(page);
  }
});

test('admin is axe-clean', async ({ page }, testInfo) => {
  await signInAs(page, e2eEnv.adminEmail, 'Admin');
  await page.goto('/admin');
  await expect(page.getByRole('heading', { level: 2, name: 'Users' })).toBeVisible();
  await page.screenshot({ path: screenshotPath('real-admin-1440', (n) => testInfo.outputPath(n)) });
  await expectNoAxeViolations(page);
});

test('invite, not-invited and login pages are axe-clean', async ({ page, browser }) => {
  const owner = await (await newClient(browser)).newPage();
  const ownerEmail = uniqueEmail('ingrid.inviter');
  await signInAs(owner, ownerEmail);
  const created = await apiCall(owner, 'POST', '/api/v1/orgs', { name: 'Choir' });
  const { slug } = (await created.json()) as { slug: string };
  const invite = await apiCall(owner, 'POST', `/api/v1/orgs/${slug}/invites`, { role: 'member' });
  const { url } = (await invite.json()) as { url: string };

  await page.goto(new URL(url).pathname);
  await expect(page.getByRole('heading', { level: 1, name: 'Join Choir' })).toBeVisible();
  await expect(page.getByText(`${displayNameOf(ownerEmail)} invited you to Choir`)).toBeVisible();
  await expectNoAxeViolations(page);

  await page.goto('/invite/no-such-token');
  await expect(page.getByRole('heading', { level: 1, name: 'Invite not found' })).toBeVisible();
  await expectNoAxeViolations(page);

  await page.goto('/not-invited?reason=not_invited');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expectNoAxeViolations(page);

  await page.goto('/login?error=access_denied');
  await expect(page.getByRole('alert')).toContainText('Sign-in didn’t work');
  await expectNoAxeViolations(page);
});

test('signing out leads to the login page', async ({ page }) => {
  await signInAs(page, uniqueEmail('otto.out'));
  await page.getByRole('button', { name: /Account menu/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to rooster' })).toBeVisible();
  expect((await apiCall(page, 'GET', '/api/v1/me')).status()).toBe(401);
});
