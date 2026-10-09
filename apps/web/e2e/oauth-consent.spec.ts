import { createHash, randomBytes } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { apiCall, signInAs, uniqueEmail, useIdentity } from './support/auth';
import { personalOrg } from './support/p3';
import { expect, test } from './support/test';

/**
 * WP 9.3 (11 §3.1, §4; ADR 0041/0042), the browser half of AC-9.3: an app starts an OAuth
 * authorization (PKCE S256, `resource`), the user sees who is asking on rooster's consent
 * screen, narrows it and allows; the app gets its code with `iss`, and the token it redeems
 * carries the narrowed grant. CIMD needs a public https metadata URL, which e2e can't serve,
 * so the client registers dynamically (`ROOSTER_OAUTH_DCR=on`) and shows as unverified.
 */

const shots = process.env.ROOSTER_P9_SCREENSHOTS;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      sessionStorage.setItem('e2e-init', '1');
      localStorage.setItem('rooster.locale', 'en');
    }
  });
});

/** A loopback redirect (an app on this computer) that nothing listens on: routed in-browser. */
function loopbackRedirect(): string {
  const port = 40_000 + Math.floor(Math.random() * 20_000);
  return `http://127.0.0.1:${port}/callback`;
}

async function registerClient(request: APIRequestContext, redirectUri: string, name: string) {
  const res = await request.post('/api/auth/oauth2/register', {
    data: {
      client_name: name,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      application_type: 'native',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
  });
  expect(res.status(), await res.text()).toBeLessThan(300);
  return ((await res.json()) as { client_id: string }).client_id;
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function authorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  challenge: string;
  scope: string;
  resource: string;
  state: string;
}): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    code_challenge: params.challenge,
    code_challenge_method: 'S256',
    scope: params.scope,
    resource: params.resource,
    state: params.state,
  });
  return `/api/auth/oauth2/authorize?${query}`;
}

/** Answers the loopback redirect in the browser and resolves with the URL it was sent to. */
async function catchRedirect(page: Page, redirectUri: string): Promise<() => Promise<URL>> {
  let resolve: (url: URL) => void = () => undefined;
  const reached = new Promise<URL>((r) => {
    resolve = r;
  });
  await page.route(`${redirectUri}**`, async (route) => {
    resolve(new URL(route.request().url()));
    await route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' });
  });
  return () => reached;
}

test('AC-9.3 consent: an unverified app on this computer asks; least privilege by default, allow; the code carries iss', async ({
  page,
  request,
  baseURL,
}) => {
  const email = uniqueEmail('oauth.consent');
  await signInAs(page, email);
  const orgId = await personalOrg(page);

  const redirectUri = loopbackRedirect();
  const clientId = await registerClient(request, redirectUri, 'E2E Agent');
  const { verifier, challenge } = pkce();
  const resource = `${baseURL}/mcp`;
  const reached = await catchRedirect(page, redirectUri);

  await page.goto(
    authorizeUrl({
      clientId,
      redirectUri,
      challenge,
      scope: 'tasks:read tasks:write tasks:delete offline_access',
      resource,
      state: 'st-123',
    }),
  );
  await page.waitForURL(/\/oauth\/consent\?/);

  const form = page.getByTestId('consent-request');
  await expect(page.getByTestId('consent-title')).toHaveText(
    'Allow E2E Agent to use your rooster account?',
  );
  await expect(page.getByTestId('consent-title')).toBeFocused();
  await expect(page.getByTestId('consent-unverified')).toHaveText('Unverified app');
  await expect(page.getByTestId('consent-domain')).toHaveText('127.0.0.1');
  await expect(page.getByTestId('consent-redirect')).toContainText('An app on this computer');
  // Least privilege (11 §3.1): writing only in the personal Inbox, deleting not allowed.
  const allowDelete = form.getByRole('checkbox', { name: /Allow deleting tasks/ });
  await expect(allowDelete).not.toBeChecked();
  await expect(form.getByRole('checkbox', { name: /Administer the server/ })).toHaveCount(0);
  await expect(form.getByTestId('grant-summary')).toContainText('only in Personal › Inbox');
  if (shots) {
    await page.screenshot({ path: `${shots}/consent-desktop.png`, fullPage: true });
  }

  await page.getByTestId('consent-approve').click();
  const callback = await reached();
  expect(callback.searchParams.get('state')).toBe('st-123');
  expect(callback.searchParams.get('iss')).toBe(`${baseURL}/api/auth`);
  const code = callback.searchParams.get('code');
  expect(code).toBeTruthy();

  const tokenRes = await request.post('/api/auth/oauth2/token', {
    form: {
      grant_type: 'authorization_code',
      code: code ?? '',
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource,
    },
  });
  expect(tokenRes.status(), await tokenRes.text()).toBe(200);
  const token = (await tokenRes.json()) as { access_token: string; scope?: string };
  expect(token.access_token).toBeTruthy();
  expect(token.scope ?? '').not.toContain('tasks:delete');

  // Settings → Connected apps shows the app with the grant the user chose.
  const grants = (await (await apiCall(page, 'GET', '/api/v1/me/grants')).json()) as {
    kind: string;
    clientId: string | null;
    scopes: string[];
    constraints: unknown;
  }[];
  const app = grants.find((g) => g.kind === 'oauth' && g.clientId === clientId);
  expect(app).toMatchObject({ scopes: ['tasks:write'] });
  expect(JSON.stringify(app?.constraints)).toContain(orgId);

  // Step-up: what the grant has stays checked and fixed (the server merges, ADR 0045 §5).
  await page.unroute(`${redirectUri}**`);
  const reachedAgain = await catchRedirect(page, redirectUri);
  await page.goto(
    authorizeUrl({
      clientId,
      redirectUri,
      challenge,
      scope: 'tasks:write comments:write',
      resource,
      state: 'st-456',
    }),
  );
  await page.waitForURL(/\/oauth\/consent\?/);
  const write = page.getByRole('checkbox', { name: /Add and change tasks/ });
  await expect(write).toBeChecked();
  await expect(write).toBeDisabled();
  await expect(page.getByTestId('fixed-scopes-hint')).toBeVisible();
  await expect(page.getByTestId('scope-comments:write').getByText('New')).toBeVisible();
  await page.getByTestId('consent-deny').click();
  expect((await reachedAgain()).searchParams.get('error')).toBe('access_denied');
});

test('consent while signed out: sign in first, then the same consent screen', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    extraHTTPHeaders: { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.7` },
  });
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem('rooster.locale', 'en'));
  const email = uniqueEmail('oauth.signedout');
  await useIdentity(context, email);

  const redirectUri = loopbackRedirect();
  const clientId = await registerClient(context.request, redirectUri, 'Late Agent');
  const { challenge } = pkce();
  const reached = await catchRedirect(page, redirectUri);

  await page.goto(
    authorizeUrl({
      clientId,
      redirectUri,
      challenge,
      scope: 'tasks:read',
      resource: `${baseURL}/mcp`,
      state: 'st-late',
    }),
  );
  await page.waitForURL(/\/login\?/);
  await page.getByRole('button', { name: 'Continue with Dev login' }).click();
  await page.waitForURL(/\/oauth\/consent\?/);
  await expect(page.getByTestId('consent-title')).toHaveText(
    'Allow Late Agent to use your rooster account?',
  );

  // Deny: the app learns `access_denied`, still with `iss` (RFC 9207).
  await page.getByTestId('consent-deny').click();
  const callback = await reached();
  expect(callback.searchParams.get('error')).toBe('access_denied');
  expect(callback.searchParams.get('iss')).toBe(`${baseURL}/api/auth`);
  await context.close();
});

test('an expired or tampered consent link is explained', async ({ page }) => {
  await signInAs(page, uniqueEmail('oauth.invalid'));
  await page.goto('/oauth/consent?client_id=x&ba_param=client_id&sig=forged');
  await expect(page.getByTestId('consent-invalid')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Go back to the app');
});

test('FR-SET-3 Settings → Security lists the sign-in identity; the only one can’t be unlinked', async ({
  page,
}) => {
  const email = uniqueEmail('identities.one');
  await signInAs(page, email);
  await page.goto('/settings/security');
  const list = page.getByTestId('linked-identities');
  await expect(list).toContainText('Dev login');
  await expect(list).toContainText(email);
  await expect(list.getByRole('button', { name: /^Unlink Dev login/ })).toBeDisabled();
  await expect(
    page.getByText('It’s your only way to sign in, so it can’t be unlinked.'),
  ).toBeVisible();
});
