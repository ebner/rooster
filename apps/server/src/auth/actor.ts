import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../lib/context.ts';
import { problemResponse } from '../lib/errors.ts';
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

/**
 * Resolves the actor of every non-public `/api/v1` request from the session cookie (04 §4.3)
 * and answers `401 unauthenticated` without one. A disabled user's sessions are rejected
 * too. Sliding session renewal cookies from better-auth are passed through.
 */
export function actorMiddleware(deps: {
  auth: Auth;
  services: Services;
}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (isPublicRoute(c.req.method, c.req.path)) return next();
    const { headers, response } = await deps.auth.api.getSession({
      headers: c.req.raw.headers,
      returnHeaders: true,
    });
    for (const cookie of headers.getSetCookie()) c.header('Set-Cookie', cookie, { append: true });
    const actor: Actor | null =
      response === null
        ? null
        : deps.services.users.resolveActor(response.user.id, response.session.id);
    if (actor === null) {
      return problemResponse(c, 401, 'unauthenticated', 'Sign in to continue.');
    }
    c.set('actor', actor);
    return next();
  };
}
