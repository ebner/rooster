import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { Config } from '../config.ts';
import { clientIp } from '../lib/client-ip.ts';
import type { AppEnv } from '../lib/context.ts';
import { problemResponse } from '../lib/errors.ts';
import type { Services } from '../services/index.ts';
import type { SignInRejection } from '../services/sign-in-policy.ts';
import { AUTH_BASE_PATH, type Auth, CLIENT_IP_HEADER } from './auth.ts';
import { clearInviteCookie } from './cookies.ts';

const REJECTIONS: ReadonlySet<string> = new Set<SignInRejection>([
  'not_invited',
  'account_disabled',
  'unverified_email',
  'account_link_blocked',
]);

/**
 * Post-processes OAuth callback responses: a sign-in rejected by the allowlist goes to the
 * SPA's `/not-invited` page (FR-AUTH-2), and a successful sign-in drops the consumed
 * `rooster.invite` cookie.
 */
function rewriteCallback(res: Response, config: Config): Response {
  const location = res.headers.get('location');
  if (location === null) return res;
  const headers = new Headers(res.headers);
  const error = new URL(location, config.baseUrl).searchParams.get('error');
  if (error !== null && REJECTIONS.has(error)) {
    headers.set('location', `${config.baseUrl}/not-invited?reason=${error}`);
  } else if (error === null) {
    headers.append('set-cookie', clearInviteCookie(config.baseUrl.startsWith('https://')));
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * The only better-auth endpoints a non-browser client may call: the CLI asks for a device
 * code and polls for its token before it has any credential (RFC 8628).
 */
const DEVICE_TOKEN_PATH = `${AUTH_BASE_PATH}/device/token`;
export const DEVICE_FLOW_PATHS: ReadonlySet<string> = new Set([
  `${AUTH_BASE_PATH}/device/code`,
  DEVICE_TOKEN_PATH,
]);

/** Headers that carry a non-browser credential (a session token as bearer, a PAT, an API key). */
const CREDENTIAL_HEADERS = ['authorization', 'x-api-key'] as const;

/**
 * better-auth's bearer plugin hands every response that sets the session cookie a
 * `set-auth-token` header. Rooster never uses it (the CLI gets its token from the device
 * flow), and it would expose the httpOnly browser session token to scripts.
 */
function withoutAuthToken(res: Response): Response {
  if (!res.headers.has('set-auth-token')) return res;
  const headers = new Headers(res.headers);
  headers.delete('set-auth-token');
  const exposed = (headers.get('access-control-expose-headers') ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h !== '' && h.toLowerCase() !== 'set-auth-token');
  if (exposed.length === 0) headers.delete('access-control-expose-headers');
  else headers.set('access-control-expose-headers', exposed.join(', '));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

const nonBrowser = (c: Context) =>
  problemResponse(
    c,
    403,
    'forbidden_scope',
    'Tokens, CLI devices and apps cannot use the sign-in endpoints; use /api/v1.',
  );

/**
 * Mounts better-auth at `/api/auth/*` (04 §4.4). Grants are enforced in `/api/v1` services,
 * so `/api/auth/*` is for the browser only (default deny): a request carrying a bearer
 * token, a PAT or an API key header is `403 forbidden_scope`, and so is a CLI device
 * session presented as a cookie. The device flow's code and token endpoints are the
 * exception; they get neither credential headers nor cookies.
 */
export function registerAuthRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: { auth: Auth; config: Config; services: Services },
): void {
  const { auth, config, services } = deps;
  app.on(['GET', 'POST'], `${AUTH_BASE_PATH}/*`, async (c) => {
    const raw = c.req.raw;
    const headers = new Headers(raw.headers);
    headers.delete(CLIENT_IP_HEADER);
    if (DEVICE_FLOW_PATHS.has(c.req.path)) {
      for (const name of CREDENTIAL_HEADERS) headers.delete(name);
      headers.delete('cookie');
    } else {
      if (CREDENTIAL_HEADERS.some((name) => headers.has(name))) return nonBrowser(c);
      if (headers.has('cookie')) {
        const current = await auth.api.getSession({ headers, query: { disableRefresh: true } });
        if (current !== null && services.grants.isGrantSession(current.session.id)) {
          return nonBrowser(c);
        }
      }
    }
    const ip = clientIp(c, config);
    if (ip !== null) headers.set(CLIENT_IP_HEADER, ip);
    const init: RequestInit = { method: raw.method, headers };
    if (raw.method !== 'GET') init.body = await raw.arrayBuffer();
    if (
      c.req.path === DEVICE_TOKEN_PATH &&
      /^application\/x-www-form-urlencoded\b/i.test(headers.get('content-type') ?? '') &&
      init.body instanceof ArrayBuffer
    ) {
      // RFC 8628 §3.4 polls with a form body, but better-auth's token endpoint takes JSON
      // only (its code endpoint takes both). Single values only: a repeated field is invalid.
      const form = new URLSearchParams(new TextDecoder().decode(init.body));
      const fields: Record<string, string> = {};
      for (const key of new Set(form.keys())) {
        const values = form.getAll(key);
        if (values.length === 1) fields[key] = values[0] as string;
      }
      init.body = JSON.stringify(fields);
      headers.set('content-type', 'application/json');
    }
    const res = withoutAuthToken(await auth.handler(new Request(raw.url, init)));
    return c.req.path.startsWith(`${AUTH_BASE_PATH}/callback/`)
      ? rewriteCallback(res, config)
      : res;
  });
}
