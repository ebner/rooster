import type { MiddlewareHandler } from 'hono';
import { NONCE, secureHeaders } from 'hono/secure-headers';
import type { AppEnv } from './context.ts';

// docs/spec/04-architecture.md §4.11. Phase 1 adds the OIDC issuers to form-action.
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

const strict = secureHeaders({ ...SHARED, contentSecurityPolicy: STRICT_CSP });

// The API reference page differs from the strict policy only by allowing Scalar's inline
// bootstrap script via nonce. Its UI bundle is served locally (no CDN, 08 §10).
const docs = secureHeaders({
  ...SHARED,
  contentSecurityPolicy: {
    ...STRICT_CSP,
    scriptSrc: ["'self'", NONCE],
    fontSrc: ["'self'", 'data:'],
  },
});

export const DOCS_PATH = '/api/docs';

export function securityHeaders(): MiddlewareHandler<AppEnv> {
  return (c, next) => (c.req.path === DOCS_PATH ? docs(c, next) : strict(c, next));
}
