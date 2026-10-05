import { apiCall, signInAs } from './support/auth';
import { e2eEnv } from './support/env';
import { expect, test } from './support/test';

test('WP 2.9 an admin backs up now, sees the snapshot listed and can download it', async ({
  page,
}) => {
  await signInAs(page, e2eEnv.adminEmail, 'Admin');
  await page.goto('/admin');
  const section = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Backups' }) });
  await expect(section).toBeVisible();
  const before = (await (await apiCall(page, 'GET', '/api/v1/admin/backups')).json()) as unknown[];
  await section.getByRole('button', { name: 'Back up now' }).click();
  await expect(page.getByText('Backup created')).toBeVisible();
  await expect(section.getByRole('row')).toHaveCount(before.length + 2); // header + new row
  const link = section.getByRole('link', { name: /Download manual-/ }).first();
  const href = await link.getAttribute('href');
  expect(href).toMatch(/^\/api\/v1\/admin\/backups\/manual-/);
  const file = await page.request.get(href as string);
  expect(file.status()).toBe(200);
});
