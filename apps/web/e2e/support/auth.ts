import { type Browser, type BrowserContext, expect, type Page } from '@playwright/test';
import { e2eEnv } from './env';
import { randomClientIp } from './test';

let counter = 0;
const run = Date.now().toString(36);

/**
 * A fresh, unique address per call, so tests never share users and every sign-in is
 * a "first login". `name` must be dot-separated words: the mock IdP derives the
 * display name from the local part ("anna.owner" → "Anna Owner").
 */
export function uniqueEmail(name: string, domain: string = e2eEnv.allowedDomain): string {
  counter += 1;
  return `${name}.${run}${counter}@${domain}`;
}

/** The display name the mock IdP gives an address. */
export function displayNameOf(email: string): string {
  return (email.split('@')[0] ?? '')
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => (part[0]?.toUpperCase() ?? '') + part.slice(1))
    .join(' ');
}

export async function newClient(
  browser: Browser,
  options: Parameters<Browser['newContext']>[0] = {},
): Promise<BrowserContext> {
  return browser.newContext({
    ...options,
    extraHTTPHeaders: { ...options.extraHTTPHeaders, 'X-Forwarded-For': randomClientIp() },
  });
}

/**
 * Makes the mock IdP sign the next authorisation in as `email`, race-free across
 * parallel workers: the authorize request gets a `login_hint`, which the IdP binds to
 * the issued code (apps/server/test/mock-idp.ts).
 */
export async function useIdentity(context: BrowserContext, email: string): Promise<void> {
  const pattern = `${e2eEnv.idpIssuer}/authorize**`;
  await context.unroute(pattern);
  await context.route(pattern, (route) => {
    const url = new URL(route.request().url());
    url.searchParams.set('login_hint', email);
    void route.continue({ url: url.toString() });
  });
}

export interface SignInOptions {
  /** Where the sign-in should end up; default: My tasks of some org. */
  landing?: RegExp;
  /** Start from this page instead of `/login` (e.g. an invite link). */
  startAt?: string;
  /** The button to press on the start page. */
  button?: string | RegExp;
}

/**
 * Signs `page` in through the real OAuth flow: login page → mock IdP → better-auth
 * callback → app. Asserts that `/me` is now `email` with display name `name`.
 */
export async function signInAs(
  page: Page,
  email: string,
  name: string = displayNameOf(email),
  options: SignInOptions = {},
): Promise<void> {
  await useIdentity(page.context(), email);
  await page.goto(options.startAt ?? '/login');
  await page.getByRole('button', { name: options.button ?? 'Continue with Dev login' }).click();
  await page.waitForURL(options.landing ?? /\/o\/[^/]+\/my$/);
  const me = await apiCall(page, 'GET', '/api/v1/me');
  expect(me.status()).toBe(200);
  expect(await me.json()).toMatchObject({ email, name });
}

/** Same-origin JSON call with the page's cookies (Origin set for the CSRF check). */
export async function apiCall(
  page: Page,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  data?: unknown,
) {
  const origin = new URL(page.url()).origin;
  return page.request.fetch(path, {
    method,
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    ...(data === undefined ? {} : { data }),
  });
}
