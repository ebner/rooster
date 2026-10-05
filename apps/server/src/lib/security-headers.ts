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
  return (c, next) => (c.req.path === DOCS_PATH ? docs(c, next) : strict(c, next));
}
