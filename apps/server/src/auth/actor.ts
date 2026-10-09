import { defaultKeyHasher } from '@better-auth/api-key';
import type { MiddlewareHandler } from 'hono';
import type { Config } from '../config.ts';
import { clientIp } from '../lib/client-ip.ts';
import type { AppEnv } from '../lib/context.ts';
import { problemResponse } from '../lib/errors.ts';
import { PAT_PREFIX } from '../services/grant-service.ts';
import type { Actor, Services } from '../services/index.ts';
import type { Auth } from './auth.ts';

/**
 * Routes under `/api/v1` that work without a session: server metadata, the OpenAPI document,
 * and the invite preview and claim used by the `/invite/:token` page before sign-in.
 */
const PUBLIC_ROUTES: readonly { method: string; path: RegExp }[] = [
  { method: 'GET', path: /^\/api\/v1\/meta$/ },
  { method: 'GET', path: /^\/api\/v1\/openapi\.json$/ },
  { method: 'GET', path: /^\/api\/v1\/invites\/[^/]+$/ },
  { method: 'POST', path: /^\/api\/v1\/invites\/[^/]+\/claim$/ },
];

export function isPublicRoute(method: string, path: string): boolean {
  return PUBLIC_ROUTES.some((r) => r.method === method && r.path.test(path));
}

/** `Authorization: Bearer <token>`; null without one. */
function bearerToken(header: string | undefined): string | null {
  if (header === undefined || header.slice(0, 7).toLowerCase() !== 'bearer ') return null;
  const token = header.slice(7).trim();
  return token === '' ? null : token;
}

/**
 * Resolves the actor of every non-public `/api/v1` request (04 §4.3–4.4) and answers `401
 * unauthenticated` without one:
 * - `Authorization: Bearer rooster_pat_…`: a PAT, looked up by its hash (the PAT prefix tells
 *   it from a session token);
 * - any other bearer token: a better-auth session through the `bearer` plugin (CLI devices);
 * - else the session cookie (the browser).
 * A session or PAT whose grant is revoked or expired, and a disabled user, get 401. Sliding
 * session renewal cookies from better-auth are passed through to cookie requests only.
 */
export function actorMiddleware(deps: {
  auth: Auth;
  services: Services;
  config: Config;
}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (isPublicRoute(c.req.method, c.req.path)) return next();
    const token = bearerToken(c.req.header('authorization'));
    const ip = clientIp(c, deps.config);
    let actor: Actor | null = null;
    if (token?.startsWith(PAT_PREFIX)) {
      actor = deps.services.grants.resolvePat(await defaultKeyHasher(token), ip);
    } else {
      // A bearer request is judged by its token alone, never by a cookie riding along.
      const headers = new Headers(c.req.raw.headers);
      if (token !== null) headers.delete('cookie');
      const { headers: out, response } = await deps.auth.api.getSession({
        headers,
        returnHeaders: true,
      });
      if (token === null) {
        for (const cookie of out.getSetCookie()) c.header('Set-Cookie', cookie, { append: true });
      }
      actor =
        response === null
          ? null
          : deps.services.grants.resolveSession(
              response.user.id,
              response.session.id,
              token === null ? 'session' : 'bearer',
              ip,
            );
    }
    if (actor === null) {
      return problemResponse(c, 401, 'unauthenticated', 'Sign in to continue.');
    }
    c.set('actor', actor);
    return next();
  };
}
