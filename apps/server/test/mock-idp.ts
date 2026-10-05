// A mock OIDC issuer for tests and local development (WP 1.7), built on oauth2-mock-server.
// Used by the server tests, by `scripts/dev-idp.mjs` (`pnpm dev:idp`) and, later, by the
// Playwright login fixture. Plain erasable TypeScript, so Node can run it without a build.
import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { type AugmentedRequest, type MutableToken, OAuth2Server } from 'oauth2-mock-server';

export interface MockIdentity {
  email: string;
  name?: string | undefined;
  /** Defaults to true. */
  emailVerified?: boolean | undefined;
}

export interface MockIdp {
  /** `http://<host>:<port>`, also the `iss` claim. */
  issuer: string;
  discoveryUrl: string;
  /** The identity for the next sign-in that carries no `login_hint`. */
  setNextUser(identity: MockIdentity): void;
  /** A `ROOSTER_OIDC_PROVIDERS` entry pointing at this issuer. */
  provider(
    id?: string,
    name?: string,
  ): {
    id: string;
    name: string;
    discoveryUrl: string;
    clientId: string;
    clientSecret: string;
  };
  stop(): Promise<void>;
}

export const DEFAULT_IDENTITY: MockIdentity = { email: 'dev@example.com' };
export const NEXT_USER_PATH = '/__next-user';

/** `sub` is stable per email, so a repeat sign-in finds the same account. */
export function subjectFor(email: string): string {
  return `mock-${createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 24)}`;
}

function displayName(email: string): string {
  const local = email.split('@')[0] ?? email;
  return local
    .split(/[._-]+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
}

function claimsFor(identity: MockIdentity): Record<string, unknown> {
  const email = identity.email.toLowerCase();
  const hash = createHash('md5').update(email).digest('hex');
  return {
    sub: subjectFor(email),
    email,
    email_verified: identity.emailVerified ?? true,
    name: identity.name ?? displayName(email),
    picture: `https://www.gravatar.com/avatar/${hash}?d=identicon`,
  };
}

function isIdentity(value: unknown): value is MockIdentity {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.email === 'string' &&
    v.email.includes('@') &&
    (v.name === undefined || typeof v.name === 'string') &&
    (v.emailVerified === undefined || typeof v.emailVerified === 'boolean')
  );
}

/**
 * Starts the issuer. Each authorization code is bound to the identity chosen when it was
 * issued: the `login_hint` query parameter (an email) if present, else the identity set by
 * `setNextUser()` or `POST /__next-user {email, name?, emailVerified?}`.
 */
export async function startMockIdp(
  options: { port?: number; host?: string } = {},
): Promise<MockIdp> {
  const server = new OAuth2Server();
  await server.issuer.keys.generate('RS256');

  let next: MockIdentity = DEFAULT_IDENTITY;
  const byCode = new Map<string, MockIdentity>();

  server.service.on('beforeAuthorizeRedirect', (redirect: { url: URL }, req: AugmentedRequest) => {
    const code = redirect.url.searchParams.get('code');
    if (code === null) return;
    const hint = (req.query as Record<string, unknown> | undefined)?.login_hint;
    byCode.set(code, typeof hint === 'string' && hint.includes('@') ? { email: hint } : next);
  });

  server.service.on('beforeTokenSigning', (token: MutableToken, req: AugmentedRequest) => {
    const code = (req.body as Record<string, unknown> | undefined)?.code;
    const identity = (typeof code === 'string' ? byCode.get(code) : undefined) ?? next;
    Object.assign(token.payload, claimsFor(identity));
  });

  server.service.addRoute('POST', NEXT_USER_PATH, (req: AugmentedRequest, res: ServerResponse) => {
    if (!isIdentity(req.body)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'expected {email, name?, emailVerified?}' }));
      return;
    }
    next = req.body;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(claimsFor(next)));
  });

  await server.start(options.port ?? 0, options.host ?? 'localhost');
  const issuer = server.issuer.url;
  if (issuer === undefined) throw new Error('mock IdP did not report an issuer URL');

  return {
    issuer,
    discoveryUrl: `${issuer}/.well-known/openid-configuration`,
    setNextUser(identity) {
      next = identity;
    },
    provider(id = 'dev', name = 'Dev login') {
      return {
        id,
        name,
        discoveryUrl: `${issuer}/.well-known/openid-configuration`,
        clientId: 'rooster-dev',
        clientSecret: 'rooster-dev-secret',
      };
    },
    stop: () => server.stop(),
  };
}
