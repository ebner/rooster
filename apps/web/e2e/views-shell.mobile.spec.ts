import type { SavedView, SavedViewCreate } from '@rooster/core/schemas';
import { apiCall } from './support/auth';
import { sharedOrg } from './support/p6-people';
import { expect, test } from './support/test';

/**
 * Phase 13, WP 13.4 on phones (02 §13.1, ADR 0073 B12): the org's views follow Everyone in the
 * view switcher, in the member's own order; a private view stays its owner's.
 */

const shotDir = process.env.ROOSTER_P13_SCREENSHOT_DIR;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      sessionStorage.setItem('e2e-init', '1');
      localStorage.setItem('rooster.locale', 'en');
    }
  });
});

const anyone: SavedViewCreate['query'] = {
  tags: [],
  tagMode: 'any',
  assignee: 'anyone',
  due: 'any',
  status: 'open',
};

async function createView(
  page: Parameters<typeof apiCall>[0],
  orgId: string,
  body: SavedViewCreate,
): Promise<SavedView> {
  const res = await apiCall(page, 'POST', `/api/v1/orgs/${orgId}/views`, body);
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as SavedView;
}

test('the view switcher lists the org’s views after Everyone', async ({ page, browser }) => {
  const { a, b, slug, orgId } = await sharedOrg(page, browser, 'views.phone');
  const juniper = await createView(a, orgId, { name: 'Juniper', query: anyone, shared: true });
  await createView(a, orgId, { name: 'Waiting', query: anyone, shared: true });
  await createView(a, orgId, { name: 'Mine', query: { ...anyone, assignee: 'me' } });

  await a.goto(`/o/${slug}/my`);
  const switcher = a.getByRole('navigation', { name: 'Views' });
  await expect(switcher.getByRole('link')).toHaveText([
    'My tasks',
    'Today',
    '7 days',
    'Overdue',
    'No date',
    'Everyone',
    'Juniper',
    'Waiting',
    'Mine',
  ]);
  await expect(switcher.getByRole('link', { name: 'My tasks' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  if (shotDir) await a.screenshot({ path: `${shotDir}/phone-switcher.png` });

  // The other member: the shared views only.
  await b.goto(`/o/${slug}/my`);
  await expect(b.getByRole('navigation', { name: 'Views' }).getByRole('link')).toHaveText([
    'My tasks',
    'Today',
    '7 days',
    'Overdue',
    'No date',
    'Everyone',
    'Juniper',
    'Waiting',
  ]);

  await switcher.getByRole('link', { name: 'Juniper' }).tap();
  await expect(a).toHaveURL(new RegExp(`/o/${slug}/v/${juniper.id}$`));
  await expect(
    a.getByRole('navigation', { name: 'Views' }).getByRole('link', { name: 'Juniper' }),
  ).toHaveAttribute('aria-current', 'page');

  // A view belongs to its org: switching orgs from it lands on My tasks (Today would stay Today).
  await a.getByTestId('org-switcher').click();
  const sheet = a.getByRole('dialog', { name: 'Organisations' });
  await sheet.getByRole('button', { name: 'Personal' }).click();
  await expect(a).toHaveURL(/\/o\/personal\/my$/);
});
