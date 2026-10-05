import { signInAs, uniqueEmail } from './support/auth';
import { clickRowBody, createTask, groupId, personalOrg } from './support/p3';
import { expect, test } from './support/test';

const out = process.env.P3_SCREENSHOTS;

test.skip(!out, 'set P3_SCREENSHOTS to a directory to capture the Phase 3 screens');

test('Phase 3 screenshots (1440 pane, 1440 full screen, 390)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInAs(page, uniqueEmail('p3.shots'));
  await expect(page.getByRole('treegrid')).toBeVisible();
  const orgId = await personalOrg(page);
  const today = await groupId(page, orgId, 'Today');
  const plan = await createTask(page, orgId, {
    title: 'Write Q4 plan',
    groupId: today,
    tagNames: ['planning', 'work'],
    dueDate: '2026-10-12',
    startDate: '2026-10-10',
    description: '## Goals\n\n- Ship the pane\n- Tags everywhere\n\n- [ ] Review with Anna',
  });
  for (const [i, title] of ['Draft outline', 'Collect numbers', 'Review with Anna'].entries()) {
    await createTask(page, orgId, {
      title,
      parentId: plan.id,
      ...(i === 0 ? { tagNames: ['work'] } : {}),
    });
  }
  await createTask(page, orgId, { title: 'Book dentist', groupId: today, tagNames: ['personal'] });
  await createTask(page, orgId, {
    title: 'Reply to Anna about the invoice',
    groupId: today,
    tagNames: ['mail', 'work', 'urgent', 'finance'],
  });
  await page.reload();
  await page.getByText('Write Q4 plan', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Show subtasks of Write Q4 plan' }).click();
  // Row body click opens the pane.
  await expect(page.getByText('Collect numbers')).toBeVisible();
  await clickRowBody(page, 'Write Q4 plan');
  await expect(page.getByTestId('detail-pane')).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/1440-pane.png` });
  await page.getByRole('button', { name: 'Full screen' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/1440-full.png` });
  await page.getByRole('button', { name: 'Exit full screen' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/390-pane.png` });
  await page.getByRole('button', { name: 'Back' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/390-list.png` });
});
