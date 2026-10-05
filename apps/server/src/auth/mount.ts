import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Config } from '../config.ts';
import { clientIp } from '../lib/client-ip.ts';
import type { AppEnv } from '../lib/context.ts';
import type { SignInRejection } from '../services/sign-in-policy.ts';
import { AUTH_BASE_PATH, type Auth, CLIENT_IP_HEADER } from './auth.ts';
import { clearInviteCookie } from './cookies.ts';

const REJECTIONS: ReadonlySet<string> = new Set<SignInRejection>([
  'not_invited',
  'account_disabled',
  'unverified_email',
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

/** Mounts better-auth at `/api/auth/*` (04 §4.4). */
export function registerAuthRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: { auth: Auth; config: Config },
): void {
  const { auth, config } = deps;
  app.on(['GET', 'POST'], `${AUTH_BASE_PATH}/*`, async (c) => {
    const raw = c.req.raw;
    const headers = new Headers(raw.headers);
    headers.delete(CLIENT_IP_HEADER);
    const ip = clientIp(c, config.trustProxy);
    if (ip !== null) headers.set(CLIENT_IP_HEADER, ip);
    const init: RequestInit = { method: raw.method, headers };
    if (raw.method !== 'GET') init.body = await raw.arrayBuffer();
    const res = await auth.handler(new Request(raw.url, init));
    return c.req.path.startsWith(`${AUTH_BASE_PATH}/callback/`)
      ? rewriteCallback(res, config)
      : res;
  });
}
