import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './context.ts';
import { problemResponse } from './errors.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * How an actor authenticated when browsers never attach the credential on their own
 * (bearer and PAT tokens, P8). None exist yet; an `Authorization` header alone proves nothing.
 */
const TOKEN_AUTH: ReadonlySet<string> = new Set(['bearer', 'pat', 'oauth']);

/**
 * CSRF defence for cookie-authenticated requests (04 §4.11): unsafe methods must come from
 * `ROOSTER_BASE_URL`'s origin and carry JSON. Runs after the actor middleware, so only an
 * actor that actually authenticated with a token is exempt; public routes (no actor) are
 * checked like cookie requests.
 */
export function csrfProtection(baseUrl: string): MiddlewareHandler<AppEnv> {
  const expected = new URL(baseUrl).origin;
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    const actor = c.get('actor');
    if (actor !== undefined && TOKEN_AUTH.has(actor.via)) return next();
    if (c.req.header('origin') !== expected) {
      return problemResponse(c, 403, 'csrf_origin', 'Cross-origin request rejected.');
    }
    const contentType = c.req.header('content-type');
    if (contentType !== undefined && !/^application\/json\b/i.test(contentType)) {
      return problemResponse(c, 415, 'unsupported_media_type', 'Send JSON (application/json).');
    }
    return next();
  };
}
