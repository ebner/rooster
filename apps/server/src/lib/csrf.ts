import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './context.ts';
import { problemResponse } from './errors.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for cookie-authenticated requests (04 §4.11): unsafe methods must come from
 * `ROOSTER_BASE_URL`'s origin and carry JSON. Bearer-authenticated requests (CLI, P8) are
 * exempt because browsers never attach them on their own.
 */
export function csrfProtection(baseUrl: string): MiddlewareHandler<AppEnv> {
  const expected = new URL(baseUrl).origin;
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    if (/^Bearer\s/i.test(c.req.header('authorization') ?? '')) return next();
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
