import type { MiddlewareHandler } from 'hono';
import { NONCE, secureHeaders } from 'hono/secure-headers';
import type { AppEnv } from './context.ts';

// docs/spec/04-architecture.md §4.11.
const STRICT_CSP = {
  defaultSrc: ["'self'"],
  baseUri: ["'self'"],
  objectSrc: ["'none'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
  fontSrc: ["'self'"],
  connectSrc: ["'self'"],
  workerSrc: ["'self'"],
  manifestSrc: ["'self'"],
  frameAncestors: ["'none'"],
  formAction: ["'self'"],
};

const SHARED = {
  referrerPolicy: 'same-origin',
  permissionsPolicy: {
    camera: [],
    microphone: [],
    geolocation: [],
    payment: [],
    usb: [],
  },
};

export const DOCS_PATH = '/api/docs';

/**
 * `formOrigins` are the sign-in providers' origins: a form POST that starts sign-in is
 * redirected to the issuer, which `form-action` must allow.
 */
export function securityHeaders(formOrigins: readonly string[] = []): MiddlewareHandler<AppEnv> {
  const csp = { ...STRICT_CSP, formAction: ["'self'", ...formOrigins] };
  const strict = secureHeaders({ ...SHARED, contentSecurityPolicy: csp });
  // The API reference page differs from the strict policy only by allowing Scalar's inline
  // bootstrap script via nonce. Its UI bundle is served locally (no CDN, 08 §10).
  const docs = secureHeaders({
    ...SHARED,
    contentSecurityPolicy: { ...csp, scriptSrc: ["'self'", NONCE], fontSrc: ["'self'", 'data:'] },
  });
  return async (c, next) => {
    if (c.req.path === DOCS_PATH) return docs(c, next);
    // A response with its own, stricter policy keeps it: downloads of user files send
    // `default-src 'none'; sandbox` (P10, ADR 0049 §3.5). hono sets its headers after the
    // handler, so the handler's value is restored afterwards.
    let own: string | null = null;
    await strict(c, async () => {
      await next();
      own = c.res.headers.get('content-security-policy');
    });
    if (own !== null) c.res.headers.set('Content-Security-Policy', own);
  };
}

/**
 * ASVS 8.2.1: API responses carry user data, so browsers and shared caches must not keep them
 * (`no-store`). A route that sets its own policy keeps it: downloads revalidate with their ETag
 * (`private, no-cache`), the event stream sends `no-cache`.
 */
export function noStoreApi(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    if (!c.res.headers.has('cache-control')) c.res.headers.set('Cache-Control', 'no-store');
  };
}
