import type { Page } from '@playwright/test';
import {
  apiCall,
  displayNameOf,
  newClient,
  signInAs,
  uniqueEmail,
  useIdentity,
} from './support/auth';
import { e2eEnv } from './support/env';
import { expect, test } from './support/test';

/** Phase 1 acceptance criteria (09 §Phase 1) against the real server and mock IdP. */

async function createOrg(page: Page, name: string): Promise<string> {
  const res = await apiCall(page, 'POST', '/api/v1/orgs', { name });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { slug: string }).slug;
}

function sidebar(page: Page) {
  return page.getByRole('navigation', { name: 'Main' });
}

test('AC-1.1 a user who is not allowlisted is sent to /not-invited and no account is created', async ({
  page,
  browser,
}) => {
  const outsider = uniqueEmail('sam.stranger', e2eEnv.outsideDomain);
  await useIdentity(page.context(), outsider);
  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with Dev login' }).click();
  await page.waitForURL(/\/not-invited\?reason=not_invited$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'You’re not on the list yet' }),
  ).toBeVisible();
  // Still signed out.
  expect((await apiCall(page, 'GET', '/api/v1/me')).status()).toBe(401);

  const admin = await (await newClient(browser)).newPage();
  await signInAs(admin, e2eEnv.adminEmail, 'Admin');
  const users = (await (await apiCall(admin, 'GET', '/api/v1/admin/users')).json()) as {
    email: string;
  }[];
  expect(users.map((u) => u.email)).not.toContain(outsider);
});

test('AC-1.2 the first login lands on My tasks of a new personal org with the default groups', async ({
  page,
}) => {
  const email = uniqueEmail('first.timer');
  await signInAs(page, email);
  await expect(page).toHaveURL(/\/o\/personal\/my$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('My tasks');
  const groups = page.getByRole('main').getByRole('heading', { level: 2 });
  await expect(groups).toHaveText(['Today', 'Prio', 'Upcoming']);
  const me = (await (await apiCall(page, 'GET', '/api/v1/me')).json()) as {
    orgs: { isPersonal: boolean }[];
  };
  expect(me.orgs.filter((o) => o.isPersonal)).toHaveLength(1);
});

test('AC-1.2 a Swedish browser gets Swedish group names', async ({ browser }) => {
  const context = await newClient(browser, { locale: 'sv-SE' });
  const page = await context.newPage();
  const email = uniqueEmail('sven.svensson');
  await useIdentity(context, email);
  await page.goto('/login');
  await page.getByRole('button', { name: 'Fortsätt med Dev login' }).click();
  await page.waitForURL(/\/o\/personal\/my$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Mina uppgifter');
  await expect(page.getByRole('main').getByRole('heading', { level: 2 })).toHaveText([
    'Idag',
    'Prio',
    'Kommande',
  ]);
  const me = (await (await apiCall(page, 'GET', '/api/v1/me')).json()) as { locale: string };
  expect(me.locale).toBe('sv');
  await context.close();
});

test('AC-1.3 an owner invites by single-use link; the invitee joins; the link cannot be reused', async ({
  page,
  browser,
}) => {
  // A creates the org from the sidebar popover.
  await signInAs(page, uniqueEmail('anna.owner'));
  await page.getByRole('button', { name: 'New organisation' }).click();
  const dialog = page.getByRole('dialog', { name: 'New organisation' });
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Northwind');
  await dialog.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/o\/northwind[^/]*\/my$/);
  await expect(sidebar(page).getByRole('region', { name: 'Northwind' })).toBeVisible();

  // A creates a single-use link invite in org settings.
  const slug = new URL(page.url()).pathname.split('/')[2] ?? '';
  await page.goto(`/o/${slug}/settings`);
  await page
    .locator('label')
    .filter({ hasText: /^Invite link$/ })
    .click();
  await page.getByRole('button', { name: 'Create link' }).click();
  const url = await page.getByRole('textbox', { name: 'Invite link' }).inputValue();
  expect(url).toMatch(/\/invite\/[\w-]+$/);
  const invitePath = new URL(url).pathname;

  // B is not allowlisted; signing in through the link admits them into the org.
  const bContext = await newClient(browser);
  const b = await bContext.newPage();
  const bEmail = uniqueEmail('bertil.invited', e2eEnv.outsideDomain);
  await b.goto(invitePath);
  await expect(b.getByRole('heading', { level: 1, name: 'Join Northwind' })).toBeVisible();
  await signInAs(b, bEmail, displayNameOf(bEmail), {
    startAt: invitePath,
    button: 'Accept and sign in',
    landing: new RegExp(`/o/${slug}/my$`),
  });
  await expect(b.getByRole('heading', { level: 1 })).toContainText('Northwind');
  await expect(sidebar(b).getByRole('region', { name: 'Northwind' })).toBeVisible();

  // A sees B as a member.
  await page.reload();
  await expect(page.getByText(bEmail)).toBeVisible();

  // C tries the same single-use link.
  const cContext = await newClient(browser);
  const c = await cContext.newPage();
  await c.goto(invitePath);
  await expect(
    c.getByRole('heading', { level: 1, name: 'This invite has been used' }),
  ).toBeVisible();
  await expect(c.getByRole('button', { name: /Accept and sign in/ })).toHaveCount(0);
  // And the API refuses it too.
  const claim = await apiCall(
    c,
    'POST',
    `/api/v1${invitePath.replace('/invite/', '/invites/')}/claim`,
  );
  expect(claim.status()).toBe(410);
  await bContext.close();
  await cContext.close();
});

test('AC-1.4 the personal org has no invite section and rejects invites', async ({ page }) => {
  await signInAs(page, uniqueEmail('pia.personal'));
  await page.goto('/o/personal/settings');
  await expect(page.getByRole('heading', { level: 2, name: 'Invites' })).toBeVisible();
  await expect(
    page.getByText(
      'Personal organisations can’t be shared. Create a new organisation to work with others.',
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Create (invite|link)/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Delete/ })).toHaveCount(0);

  const invite = await apiCall(page, 'POST', '/api/v1/orgs/personal/invites', { role: 'member' });
  expect(invite.status()).toBe(409);
  expect(((await invite.json()) as { code: string }).code).toBe('personal_org');
  const del = await apiCall(page, 'DELETE', '/api/v1/orgs/personal', { confirmName: 'Personal' });
  expect(del.status()).toBe(409);
});

test('AC-1.5 dragging an org above Personal persists across reload (pointer and keyboard)', async ({
  page,
}) => {
  await signInAs(page, uniqueEmail('dora.dragger'));
  await createOrg(page, 'Book club');
  await page.reload();
  const sections = sidebar(page).getByRole('region');
  await expect(sections).toHaveCount(2);
  await expect(sections.nth(0)).toHaveAccessibleName('Personal');

  // Pointer: drag the "Book club" header above "Personal".
  const source = sidebar(page).getByRole('button', { name: 'Book club', exact: true });
  const target = sidebar(page).getByRole('button', { name: 'Personal', exact: true });
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error('sidebar headers not laid out');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, from.y - 10, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y - 4, { steps: 10 });
  await page.mouse.up();
  await expect(sections.nth(0)).toHaveAccessibleName('Book club');
  await expect
    .poll(
      async () =>
        ((await (await apiCall(page, 'GET', '/api/v1/me')).json()) as { orgs: { name: string }[] })
          .orgs[0]?.name,
    )
    .toBe('Book club');
  await page.reload();
  await expect(sections.nth(0)).toHaveAccessibleName('Book club');

  // Keyboard: lift "Personal" with its grip and move it back up.
  await sidebar(page).getByRole('button', { name: 'Reorder Personal' }).focus();
  const live = page.getByRole('status').filter({ hasText: /Personal/ });
  await page.keyboard.press('Space');
  await expect(live).toHaveText('Picked up Personal. Position 2 of 2.');
  await page.keyboard.press('ArrowUp');
  await expect(live).toHaveText('Personal is at position 1 of 2.');
  await page.keyboard.press('Space');
  await expect(sections.nth(0)).toHaveAccessibleName('Personal');
  await expect
    .poll(
      async () =>
        ((await (await apiCall(page, 'GET', '/api/v1/me')).json()) as { orgs: { name: string }[] })
          .orgs[0]?.name,
    )
    .toBe('Personal');
  await page.reload();
  await expect(sections.nth(0)).toHaveAccessibleName('Personal');
});

test('AC-1.7 revoking a session in Settings signs that browser out on its next request', async ({
  page,
  browser,
}) => {
  const email = uniqueEmail('rita.revoker');
  await signInAs(page, email);
  const otherContext = await newClient(browser);
  const other = await otherContext.newPage();
  await signInAs(other, email);

  await page.goto('/settings/security');
  const devices = page.getByRole('region', { name: 'Signed-in devices' }).getByRole('listitem');
  await expect(devices).toHaveCount(2);
  await expect(devices.filter({ hasText: 'This device' })).toHaveCount(1);
  await devices
    .filter({ hasNotText: 'This device' })
    .getByRole('button', { name: /^Sign out/ })
    .click();
  await expect(page.getByText('Device signed out')).toBeVisible();
  await expect(devices).toHaveCount(1);

  await other.reload();
  await other.waitForURL(/\/login\?redirect=/);
  await expect(other.getByRole('heading', { level: 1, name: 'Sign in to rooster' })).toBeVisible();
  // This browser stays signed in.
  await page.goto('/o/personal/my');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('My tasks');
  await otherContext.close();
});

test('admin adds an allowlist entry, and disabling a user signs them out and blocks sign-in', async ({
  page,
  browser,
}) => {
  // A user from outside the allowlist, admitted by the entry the admin adds.
  const newcomer = uniqueEmail('nina.newcomer', e2eEnv.outsideDomain);
  await signInAs(page, e2eEnv.adminEmail, 'Admin');
  await page.goto('/admin');
  await page.getByRole('textbox', { name: 'Email address or domain' }).fill(newcomer);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('listitem').filter({ hasText: newcomer })).toBeVisible();

  const userContext = await newClient(browser);
  const user = await userContext.newPage();
  await signInAs(user, newcomer);

  await page.reload();
  const row = page.getByRole('row').filter({ hasText: newcomer });
  await row.getByRole('button', { name: `Disable ${displayNameOf(newcomer)}` }).click();
  await expect(row.getByText('Disabled')).toBeVisible();

  await user.reload();
  await user.waitForURL(/\/login/);
  await user.getByRole('button', { name: 'Continue with Dev login' }).click();
  await user.waitForURL(/\/not-invited\?reason=account_disabled$/);
  await expect(
    user.getByRole('heading', { level: 1, name: 'Your account is disabled' }),
  ).toBeVisible();
  await userContext.close();
});

test('non-admins get a 404 for /admin', async ({ page }) => {
  await signInAs(page, uniqueEmail('olle.ordinary'));
  await page.goto('/admin');
  await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
});

test('signed-out visitors are sent to /login and come back afterwards', async ({ page }) => {
  await page.goto('/settings/profile');
  await page.waitForURL(/\/login\?redirect=%2Fsettings%2Fprofile$/);
  const email = uniqueEmail('ruth.returner');
  await signInAs(page, email, displayNameOf(email), {
    startAt: page.url(),
    landing: /\/settings\/profile$/,
  });
  await expect(page.getByRole('heading', { level: 2, name: 'Profile' })).toBeVisible();
});
