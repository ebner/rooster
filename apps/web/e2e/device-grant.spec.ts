import type { APIRequestContext, Page } from '@playwright/test';
import { expectAxeClean } from './support/a11y';
import { apiCall, signInAs, uniqueEmail } from './support/auth';
import { e2eEnv } from './support/env';
import { expect, test } from './support/test';

/**
 * Phase 12 (11 §9, ADR 0065), the browser half of AC-12.1 to AC-12.3:
 * - the OAuth device grant: rooster's CLI asks at `/api/auth/oauth2/device-authorization` (the
 *   default `first-party` mode), the user types the code at `/device`, sees the full context
 *   (who, the code, the request IP and age, the warning) and allows; the CLI's poll gets an
 *   access and a refresh token; the `device_connected` notice leads to the grant;
 * - the user-code lookup limit (AC-12.2);
 * - MCP tokens from Settings → Connected apps, with their setup lines (AC-12.3).
 * A third-party device client needs a public CIMD document, which e2e can't serve; its page
 * states are covered by the unit tests and the kitchen sink.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      sessionStorage.setItem('e2e-init', '1');
      localStorage.setItem('rooster.locale', 'en');
    }
  });
});

interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const requestIp = '203.0.113.7';

async function startDeviceFlow(
  request: APIRequestContext,
  baseURL: string,
  scope = 'tasks:read tasks:write',
): Promise<DeviceAuthorization> {
  const res = await request.post('/api/auth/oauth2/device-authorization', {
    headers: { 'X-Forwarded-For': requestIp },
    form: { client_id: 'rooster-cli', scope, resource: `${baseURL}/api/v1` },
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as DeviceAuthorization;
}

/** Types the code as a user would and continues to the request. */
async function enterCode(page: Page, userCode: string) {
  await page.getByRole('textbox', { name: 'Code' }).fill(userCode.toLowerCase());
  await page.getByRole('button', { name: 'Continue' }).click();
}

test('AC-12.1 /device: the CLI on the device grant, typed code, full context, Allow; the notice leads to the grant', async ({
  page,
  request,
  baseURL,
}) => {
  test.setTimeout(90_000);
  const flow = await startDeviceFlow(request, baseURL as string);
  // No pre-filled link (11 §9.2): the user types the code.
  expect(flow.verification_uri_complete).toBeUndefined();
  expect(new URL(flow.verification_uri).pathname).toBe('/device');

  const email = uniqueEmail('device.grant');
  await signInAs(page, email, undefined, { startAt: '/device', landing: /\/device$/ });
  await expect(page.getByTestId('device-code-form')).toBeVisible();
  await expectAxeClean(page, 'device code');
  await enterCode(page, flow.user_code);

  const form = page.getByTestId('device-request');
  await expect(form.getByRole('heading', { name: 'Connect a device' })).toBeVisible();
  await expect(page.getByTestId('device-client-name')).toHaveText('rooster CLI');
  await expect(page.getByTestId('device-unverified')).toHaveCount(0);
  await expect(page.getByTestId('device-account')).toHaveText(email);
  await expect(page.getByTestId('device-user-code')).toHaveText(
    `${flow.user_code.replace(/-/g, '').slice(0, 4)}-${flow.user_code.replace(/-/g, '').slice(4)}`,
  );
  await expect(page.getByTestId('device-origin')).toContainText(requestIp);
  await expect(page.getByTestId('device-origin')).toContainText('started');
  await expect(page.getByTestId('device-warning')).toContainText(
    'Nobody from rooster will ever ask you for this code.',
  );
  await expect(page.getByTestId('device-resource')).toHaveText('The rooster API');
  // Deny before Allow in the reading order.
  const order = await form.evaluate((node) =>
    [...node.querySelectorAll('[data-testid="device-deny"], [data-testid="device-approve"]')].map(
      (button) => button.getAttribute('data-testid'),
    ),
  );
  expect(order).toEqual(['device-deny', 'device-approve']);
  await expectAxeClean(page, 'device approval (device grant)');

  await page.getByTestId('device-approve').click();
  await expect(page.getByTestId('device-done')).toContainText('rooster CLI is connected');

  // The CLI's poll gets an access and a refresh token.
  let tokens: { access_token: string; refresh_token?: string } | null = null;
  await expect
    .poll(
      async () => {
        const res = await request.post('/api/auth/oauth2/token', {
          form: {
            grant_type: DEVICE_GRANT,
            device_code: flow.device_code,
            client_id: 'rooster-cli',
            resource: `${baseURL}/api/v1`,
          },
        });
        if (res.status() === 200) {
          tokens = (await res.json()) as typeof tokens;
          return 'issued';
        }
        return ((await res.json()) as { error?: string }).error ?? String(res.status());
      },
      { timeout: 30_000, intervals: [1_000, (flow.interval + 1) * 1_000] },
    )
    .toBe('issued');
  const issued = tokens as unknown as { access_token: string; refresh_token?: string };
  expect(issued.refresh_token).toBeTruthy();
  const me = await request.get('/api/v1/me', {
    headers: { Authorization: `Bearer ${issued.access_token}` },
  });
  expect(me.status()).toBe(200);

  const grants = (await (await apiCall(page, 'GET', '/api/v1/me/grants')).json()) as {
    id: string;
    kind: string;
    clientId: string | null;
  }[];
  const grant = grants.find((g) => g.clientId === 'rooster-cli');
  expect(grant).toBeTruthy();

  // The security notice (11 §9.4), in the inbox: no actor, no task; it opens the grant.
  await page.goto('/inbox');
  const notice = page.getByTestId('notification').filter({ hasText: 'was connected' });
  await expect(notice).toContainText(`rooster CLI`);
  await expect(notice).toContainText(requestIp);
  await expect(notice).toContainText('Not you? Revoke it in Settings → Connected apps.');
  await notice.locator('[data-inbox-item]').click();
  await expect(page).toHaveURL(new RegExp(`/settings/security#grant-${grant?.id}$`));
  await expect(page.getByTestId(`grant-${grant?.id}`)).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId(`grant-${grant?.id}`)).toBeInViewport();
});

test('AC-12.1 /device: a code that came with a link is only pre-filled, never looked up on its own', async ({
  page,
  request,
  baseURL,
}) => {
  const flow = await startDeviceFlow(request, baseURL as string);
  await signInAs(page, uniqueEmail('device.link'), undefined, {
    startAt: `/device?user_code=${flow.user_code}`,
    landing: /\/device\?user_code=/,
  });
  await expect(page.getByRole('textbox', { name: 'Code' })).toHaveValue(
    /^[A-Z0-9]{4}-[A-Z0-9]{4}$/,
  );
  await expect(page.getByText(/Continue only if your device shows the same code/)).toBeVisible();
  await expect(page.getByTestId('device-request')).toHaveCount(0);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('device-request')).toBeVisible();
  await page.getByTestId('device-deny').click();
  await expect(page.getByTestId('device-done')).toContainText('Access denied');
  const res = await request.post('/api/auth/oauth2/token', {
    form: {
      grant_type: DEVICE_GRANT,
      device_code: flow.device_code,
      client_id: 'rooster-cli',
      resource: `${baseURL}/api/v1`,
    },
  });
  expect(((await res.json()) as { error?: string }).error).toBe('access_denied');
});

test('AC-12.2 /device: ten wrong codes lock code entry, and the page says so', async ({ page }) => {
  await signInAs(page, uniqueEmail('device.locked'), undefined, {
    startAt: '/device',
    landing: /\/device$/,
  });
  for (let miss = 0; miss < 10; miss++) {
    const res = await apiCall(page, 'GET', `/api/v1/device/ZZZZZZZ${'23456789'[miss % 8]}`);
    expect(res.status()).toBe(404);
  }
  await enterCode(page, 'ZZZZ-ZZZZ');
  await expect(page.getByRole('alert')).toContainText('Too many wrong codes');
});

test('AC-12.3 Connected apps: an MCP token, its setup lines, refused by the API, accepted at /mcp', async ({
  page,
  request,
  baseURL,
}) => {
  await signInAs(page, uniqueEmail('mcp.token'));
  const section = page.locator('#connected-apps');
  await page.goto('/settings/security');
  await section.getByTestId('new-token').click();
  const form = section.getByTestId('new-token-form');
  await form.getByRole('textbox', { name: /Name/ }).fill('Agent on build-box');
  await form.getByTestId('token-audience').getByText('MCP', { exact: true }).click();
  await expect(form.getByText(/can’t administer the server/)).toBeVisible();
  await expectAxeClean(page, 'new MCP token');
  await form.getByRole('button', { name: 'Create token' }).click();

  const reveal = section.getByTestId('token-reveal');
  const token = await reveal.getByTestId('token-value').inputValue();
  expect(token).toMatch(/^rooster_pat_/);
  const lines = reveal.getByTestId('mcp-setup-line');
  await expect(lines).toHaveCount(3);
  await expect(lines.nth(0)).toContainText(
    `claude mcp add --transport http rooster ${baseURL}/mcp --header "Authorization: Bearer ${token}"`,
  );
  await expect(lines.nth(1)).toContainText(`url = "${baseURL}/mcp"`);
  await expect(lines.nth(2)).toContainText(`export ROOSTER_MCP_TOKEN="${token}"`);
  await expectAxeClean(page, 'MCP token setup');
  await reveal.getByRole('button', { name: 'Done' }).click();

  const row = section.getByTestId('connected-apps').locator('li').filter({
    hasText: 'Agent on build-box',
  });
  await expect(row.getByText('MCP', { exact: true })).toBeVisible();

  const headers = { Authorization: `Bearer ${token}` };
  expect((await request.get('/api/v1/me', { headers })).status()).toBe(401);
  const rpc = await request.post(`http://localhost:${e2eEnv.apiPort}/mcp`, {
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_orgs', arguments: {} },
    },
  });
  expect(rpc.status(), await rpc.text()).toBe(200);
  expect(await rpc.text()).not.toContain('"isError":true');
});
