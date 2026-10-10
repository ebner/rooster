import type { AdminSystem } from '@rooster/core/schemas';
import { apiCall, signInAs, uniqueEmail } from './support/auth';
import { e2eEnv } from './support/env';
import { expect, test } from './support/test';

/** AC-11.5, 08 §9, ADR 0052 §7: Admin → System shows every item, for instance admins only. */

test('AC-11.5 an admin sees every item of 08 §9 in Admin → System and can refresh it', async ({
  page,
}) => {
  await signInAs(page, e2eEnv.adminEmail, 'Admin');
  // Compare with the answer the page rendered: the instance is shared, so other tests make
  // backups and the scheduler records jobs between any two requests.
  const loaded = page.waitForResponse((r) => r.url().endsWith('/api/v1/admin/system'));
  await page.goto('/admin');
  const response = await loaded;
  expect(response.status()).toBe(200);
  const system = (await response.json()) as AdminSystem;

  const section = page.getByTestId('system-section');
  await expect(page.getByRole('heading', { level: 2, name: 'System' })).toBeVisible();
  await expect(section.getByTestId('system-version')).toContainText(system.version);
  await expect(section.getByTestId('system-started')).toContainText(/ago|just now/);
  await expect(section.getByTestId('system-database')).toContainText('write-ahead log');
  await expect(section.getByTestId('system-backup')).toContainText(
    system.lastBackup ? system.lastBackup.name : 'No backups yet',
  );
  await expect(section.getByTestId('system-smtp')).toContainText(
    system.smtp.configured ? 'Configured' : 'Not configured',
  );
  await expect(section.getByTestId('system-push')).toContainText(/devices? subscribed/);
  await expect(section.getByTestId('system-sse')).toContainText(/\d/);
  await expect(section.getByTestId('system-storage')).toContainText(/files?/);
  await expect(section.getByTestId('system-counts')).toContainText(/users?/);
  if (system.jobs.length > 0) {
    await expect(section.getByTestId('system-jobs').getByRole('row')).toHaveCount(
      system.jobs.length + 1,
    );
    await expect(
      section
        .getByTestId('system-jobs')
        .getByRole('rowheader', { name: system.jobs[0]?.job ?? '' }),
    ).toBeVisible();
  }

  // The exact time shows on keyboard focus too.
  await section.getByTestId('system-started').locator('time').focus();
  await expect(page.getByRole('tooltip')).toBeVisible();

  const refreshed = page.waitForResponse((r) => r.url().endsWith('/api/v1/admin/system'));
  await page.getByRole('button', { name: 'Refresh' }).click();
  expect((await refreshed).status()).toBe(200);

  // Rebuild search index: asked inline, then the result.
  const reindex = section.getByTestId('system-reindex');
  await reindex.getByRole('button', { name: 'Rebuild search index' }).click();
  await expect(reindex.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await reindex.getByRole('button', { name: 'Rebuild', exact: true }).click();
  await expect(reindex.getByRole('status')).toHaveText(
    /^Search index rebuilt: [\d,]+ tasks? in [\d,]+ ms\.$/,
  );
});

test('AC-11.5 members get no System: the page is a 404 and the API refuses', async ({ page }) => {
  await signInAs(page, uniqueEmail('sys.member'));
  expect([403, 404]).toContain((await apiCall(page, 'GET', '/api/v1/admin/system')).status());
  await page.goto('/admin');
  await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
  await expect(page.getByTestId('system-section')).toHaveCount(0);
});
