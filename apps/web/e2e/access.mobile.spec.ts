import { apiCall, signInAs, uniqueEmail } from './support/auth';
import { groupId, personalOrg } from './support/p3';
import { frameState } from './support/phone-frame';
import { expect, test } from './support/test';

/**
 * WP 8.2, AC-8.1 (the page part): a device code requested by the CLI is approved on a phone
 * with a narrowed grant; the CLI's token then carries exactly that grant. The full CLI plus
 * browser flow is the CLI's spec.
 */

const shots = process.env.ROOSTER_P8_SCREENSHOTS;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      sessionStorage.setItem('e2e-init', '1');
      localStorage.setItem('rooster.locale', 'en');
    }
  });
});

interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri_complete: string;
}

test('AC-8.1 /device on a phone: sign in, check the code, narrow to Prio, approve; the token has that grant', async ({
  page,
  request,
}, testInfo) => {
  const codeRes = await request.post('/api/auth/device/code', {
    form: { client_id: 'rooster-cli', scope: 'tasks:delete comments:write groups:write' },
  });
  expect(codeRes.status(), await codeRes.text()).toBe(200);
  const code = (await codeRes.json()) as DeviceCode;
  const verify = new URL(code.verification_uri_complete);
  expect(verify.pathname).toBe('/device');

  // Signed out: the page sends the phone to sign in, then back to the same code.
  await signInAs(page, uniqueEmail('device.phone'), undefined, {
    startAt: verify.pathname + verify.search,
    landing: /\/device\?user_code=/,
  });
  const orgId = await personalOrg(page);
  const prio = await groupId(page, orgId, 'Prio');
  const today = await groupId(page, orgId, 'Today');

  const requestForm = page.getByTestId('device-request');
  await expect(requestForm.getByRole('heading', { name: 'Connect rooster CLI?' })).toBeVisible();
  await expect(page.getByTestId('device-user-code')).toHaveText(
    `${code.user_code.slice(0, 4)}-${code.user_code.slice(4)}`,
  );
  // The CLI's request is the default and the ceiling: nothing beyond it is offered.
  // Deleting is its own checkbox, ticked as the CLI asked (ADR 0042 §4).
  await expect(requestForm.getByRole('checkbox', { name: /Allow deleting tasks/ })).toBeChecked();
  await expect(requestForm.getByRole('checkbox', { name: /Read notifications/ })).toHaveCount(0);

  // Narrow: only the personal org, writing only in Prio, without delete.
  await requestForm.getByText('Allow deleting tasks', { exact: true }).tap();
  await requestForm.getByText('All organisations', { exact: true }).tap();
  await requestForm
    .getByTestId(`write-${orgId}`)
    .getByText('Only these groups', { exact: true })
    .tap();
  await requestForm
    .getByRole('listbox', { name: /Groups it may change in/ })
    .getByRole('option', { name: 'Prio' })
    .tap();
  await expect(requestForm.getByRole('option', { name: 'Prio' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(requestForm.getByTestId('grant-summary')).toContainText('only in Personal › Prio');
  await expect(page.getByTestId('device-approve')).toBeEnabled();
  if (shots && testInfo.project.name === 'mobile') {
    await page.screenshot({
      path: `${shots}/device-phone.png`,
      fullPage: true,
      animations: 'disabled',
    });
  }
  await page.getByTestId('device-approve').tap();
  await expect(page.getByTestId('device-done')).toContainText('You can go back to your terminal.');
  if (shots && testInfo.project.name === 'mobile') {
    await page.screenshot({ path: `${shots}/device-phone-done.png`, animations: 'disabled' });
  }

  // The CLI polls and gets a bearer session bound to the narrowed grant.
  const tokenRes = await request.post('/api/auth/device/token', {
    data: {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: code.device_code,
      client_id: 'rooster-cli',
    },
  });
  expect(tokenRes.status(), await tokenRes.text()).toBe(200);
  const { access_token: accessToken } = (await tokenRes.json()) as { access_token: string };
  const bearer = { Authorization: `Bearer ${accessToken}` };
  const me = await request.get('/api/v1/me', { headers: bearer });
  expect(me.status()).toBe(200);
  const meBody = (await me.json()) as { email: string };
  expect(meBody.email).toMatch(/^device\.phone\./);

  const grants = (await (await apiCall(page, 'GET', '/api/v1/me/grants')).json()) as {
    kind: string;
    clientId: string | null;
    scopes: string[];
    constraints: unknown;
  }[];
  const device = grants.find((g) => g.kind === 'device');
  expect(device).toMatchObject({
    clientId: 'rooster-cli',
    scopes: ['tasks:write', 'comments:write', 'groups:write'],
    constraints: { orgs: [{ orgId, read: 'all', write: { groups: [prio] } }] },
  });
  const outside = await request.post(`/api/v1/orgs/${orgId}/tasks`, {
    headers: bearer,
    data: { title: 'Not in Today', groupId: today },
  });
  expect(outside.status()).toBe(403);

  // The code is used up: opening it again explains so.
  await page.goto(verify.pathname + verify.search);
  await expect(page.getByRole('alert')).toContainText(/already been used|expired|doesn’t match/);
});

test('/device: a wrong code is explained, and a code can be typed in', async ({ page }) => {
  await signInAs(page, uniqueEmail('device.typo'), undefined, {
    startAt: '/device',
    landing: /\/device$/,
  });
  await page.getByRole('textbox', { name: 'Code' }).fill('zzzz-zzzz');
  await page.getByRole('button', { name: 'Continue' }).tap();
  await expect(page).toHaveURL(/\/device\?user_code=ZZZZZZZZ$/);
  await expect(page.getByRole('alert')).toContainText('That code doesn’t match');
});

test('Connected apps on a phone: choosing "Only these groups" keeps the screen in place', async ({
  page,
}) => {
  await signInAs(page, uniqueEmail('pat.phone'));
  const section = page.locator('#connected-apps');
  // WebKit may still be finishing the post-sign-in redirect: retry the navigation.
  await expect(async () => {
    await page.goto('/settings/security');
    await expect(section.getByTestId('new-token')).toBeVisible({ timeout: 2_000 });
  }).toPass();
  await section.getByTestId('new-token').tap();
  const form = section.getByTestId('new-token-form');
  // The visually hidden radio inputs used to escape the scrolling <main>: focused on tap, they
  // scrolled the fixed phone frame itself and left the screen blank.
  await form
    .locator('[data-testid^="read-"][role="radiogroup"]')
    .getByText('Only these groups', { exact: true })
    .tap();
  await expect(form.getByRole('listbox', { name: /Groups it may read in/ })).toBeInViewport();
  const frame = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>('[data-shell="mobile"]');
    return { top: shell?.scrollTop ?? -1, left: shell?.scrollLeft ?? -1 };
  });
  expect(frame).toEqual({ top: 0, left: 0 });
  const state = await frameState(page);
  expect(state.headerTop).toBe(0);
  expect(state.docScrollTop).toBe(0);
  await expect(page.getByTestId('mobile-header')).toBeInViewport();
});
