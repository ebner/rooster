import { GRANT_SCOPES, type GrantScope } from '@rooster/core/grants';
import { isBearerToken } from './api.ts';
import { CliError, EXIT } from './errors.ts';
import { t } from './i18n.ts';

/**
 * The OAuth 2.0 side of `rooster login` (11 §9.2, §9.6): RFC 8628 device authorization and
 * polling, refresh-token rotation and RFC 7009 revocation on rooster's authorization server
 * (`<base>/api/auth/oauth2/*`). Every request is form-encoded with `client_id=rooster-cli`
 * and exactly one `resource` (RFC 8707). Only HTTP lives here; storing tokens and
 * serialising refreshes across processes is the caller's job (`runtime.ts`).
 */

/** The pre-registered first-party client (11 §9.1). */
export const CLI_CLIENT_ID = 'rooster-cli';

export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/** Where an OAuth login's tokens work: the REST API or the remote MCP endpoint (11 §4.3). */
export const AUDIENCES = ['api', 'mcp'] as const;
export type Audience = (typeof AUDIENCES)[number];

const RESOURCE_PATH: Record<Audience, string> = { api: '/api/v1', mcp: '/mcp' };

/** The `resource` indicator for an audience as this CLI addresses the server. */
export function resourceFor(server: string, audience: Audience): string {
  return `${server}${RESOURCE_PATH[audience]}`;
}

/** `localhost`, `127.0.0.0/8` or `::1`: the only hosts an http (not https) resource may name. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * The server's canonical `resource` for an audience, from its RFC 9728 protected resource
 * metadata (`<server>/.well-known/oauth-protected-resource/api/v1` or `…/mcp`). The server
 * binds tokens to the URI of its configured base URL, which may differ from the one the CLI
 * uses (another host name for the same instance, a proxy). Only an https URI (http on a
 * loopback host) ending in the audience's path is taken; anything else, or no document, falls back to `resourceFor`.
 */
export async function discoverResource(
  send: Send,
  server: string,
  audience: Audience,
): Promise<string> {
  const path = RESOURCE_PATH[audience];
  const fallback = resourceFor(server, audience);
  try {
    const response = await send(
      new Request(`${server}/.well-known/oauth-protected-resource${path}`, {
        headers: { accept: 'application/json' },
      }),
    );
    if (!response.ok) return fallback;
    const data = (await response.json().catch(() => null)) as { resource?: unknown } | null;
    const resource = data?.resource;
    if (typeof resource !== 'string' || resource.length > 2048 || !resource.endsWith(path)) {
      return fallback;
    }
    const url = new URL(resource);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
      return fallback;
    }
    if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
      return fallback;
    }
    return resource;
  } catch {
    return fallback;
  }
}

/** Sends one request (the CLI's `cliFetch`: timeouts, exit 6 on a network failure). */
export type Send = (request: Request) => Promise<Response>;

/** A device authorization response, validated (RFC 8628 §3.2). */
export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Seconds the codes live. */
  expiresIn: number;
  /** Seconds between polls. */
  interval: number;
}

/** An access token and its rotating refresh token, as the token endpoint issued them. */
export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token expires (the client's clock at receipt plus `expires_in`). */
  expiresAt: number;
  /** The capabilities granted (unknown names dropped). */
  scopes: GrantScope[];
}

/**
 * The refresh token was refused (`invalid_grant`): the grant was revoked or expired, or the
 * token was used twice (which revokes the grant). Only a new login helps.
 */
export class GrantEndedError extends Error {
  constructor() {
    super('invalid_grant');
    this.name = 'GrantEndedError';
  }
}

/** RFC 8628 §6.1: short, typed by hand. Anything else never reaches the terminal. */
const USER_CODE_RE = /^[A-Za-z0-9-]{4,32}$/;
/** A device code is opaque but bounded (it is only ever sent back to the server). */
const DEVICE_CODE_RE = /^[A-Za-z0-9._~+/=-]{16,512}$/;

/** Bounds for server-chosen timing, so a hostile answer can't hang or spin the CLI. */
const MAX_EXPIRES_IN_S = 1_800;
const MAX_INTERVAL_S = 60;
const MAX_TOKEN_LIFETIME_S = 86_400;
/** The spec's access-token lifetime (11 §2.4), assumed when the server leaves it out. */
const DEFAULT_TOKEN_LIFETIME_S = 900;
/** RFC 8628 §3.5: `slow_down` adds 5 seconds to the interval for good. */
const SLOW_DOWN_S = 5;

/** `KXRT49WM` → `KXRT-49WM` (11 §9.2); other shapes are shown as they are. */
export function formatUserCode(code: string): string {
  const bare = code.replace(/[-\s]/g, '').toUpperCase();
  return /^[A-Z0-9]{8}$/.test(bare) ? `${bare.slice(0, 4)}-${bare.slice(4)}` : code;
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

function boundedInt(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : fallback;
}

/** An OAuth error code as it may be printed: short and plain, or nothing. */
function errorCode(data: Record<string, unknown>, status: number): string {
  const code = data.error;
  return typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code) ? code : `http_${status}`;
}

async function post(
  send: Send,
  server: string,
  path: string,
  params: Record<string, string>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await send(
    new Request(`${server}/api/auth/oauth2/${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams(params).toString(),
    }),
  );
  let text: string;
  try {
    text = await response.text();
  } catch {
    // The headers arrived but the body didn't (the connection closed, the timeout hit). Only
    // a success may have been acted on (a rotated refresh token): that is a lost answer,
    // exit 6 like any network failure (`isLostRefresh`). Any other status keeps its class,
    // with an empty body: a 4xx or 429 is never retried, a 5xx is a server error.
    if (response.status >= 200 && response.status < 300) {
      throw new CliError(EXIT.network, t('error.network', { server }));
    }
    text = '';
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = {};
  }
  return {
    status: response.status,
    data:
      typeof data === 'object' && data !== null && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : {},
  };
}

/**
 * Starts the device grant. `unsupported` when the server has no such endpoint (an older
 * server: 404/405) or doesn't let `rooster-cli` use it (`unauthorized_client`, the operator
 * switch `off`): the caller may fall back to the legacy device flow.
 */
export async function startDeviceAuthorization(
  send: Send,
  server: string,
  request: { scopes: readonly GrantScope[]; resource: string },
): Promise<{ kind: 'grant'; authorization: DeviceAuthorization } | { kind: 'unsupported' }> {
  const { status, data } = await post(send, server, 'device-authorization', {
    client_id: CLI_CLIENT_ID,
    scope: request.scopes.join(' '),
    resource: request.resource,
  });
  if (status === 404 || status === 405 || data.error === 'unauthorized_client') {
    return { kind: 'unsupported' };
  }
  if (status !== 200) {
    throw new CliError(EXIT.auth, t('login.failed', { error: errorCode(data, status) }));
  }
  const deviceCode = str(data.device_code);
  const userCode = str(data.user_code);
  const verificationUri = str(data.verification_uri);
  if (
    deviceCode === undefined ||
    !DEVICE_CODE_RE.test(deviceCode) ||
    userCode === undefined ||
    !USER_CODE_RE.test(userCode) ||
    verificationUri === undefined
  ) {
    throw new CliError(EXIT.auth, t('login.failed', { error: 'invalid_device_response' }));
  }
  return {
    kind: 'grant',
    authorization: {
      deviceCode,
      userCode,
      verificationUri,
      expiresIn: boundedInt(data.expires_in, 1, MAX_EXPIRES_IN_S, 600),
      interval: boundedInt(data.interval, 1, MAX_INTERVAL_S, 5),
    },
  };
}

/** A token endpoint success, validated; `previousRefresh` is kept when none is rotated in. */
function tokenSet(
  data: Record<string, unknown>,
  now: number,
  previousRefresh?: string,
): TokenSet | null {
  const accessToken = str(data.access_token);
  const refreshToken = str(data.refresh_token) ?? previousRefresh;
  const type = data.token_type;
  if (
    accessToken === undefined ||
    !isBearerToken(accessToken) ||
    refreshToken === undefined ||
    !isBearerToken(refreshToken) ||
    (type !== undefined && (typeof type !== 'string' || type.toLowerCase() !== 'bearer'))
  ) {
    return null;
  }
  const lifetime = boundedInt(data.expires_in, 1, MAX_TOKEN_LIFETIME_S, DEFAULT_TOKEN_LIFETIME_S);
  const granted = typeof data.scope === 'string' ? data.scope.split(' ') : [];
  return {
    accessToken,
    refreshToken,
    expiresAt: now + lifetime * 1000,
    scopes: GRANT_SCOPES.filter((s) => granted.includes(s)),
  };
}

export interface PollContext {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/**
 * Polls the token endpoint until the user approves, denies or the code expires (RFC 8628
 * §3.4–3.5), waiting `interval` between polls and 5 s longer after each `slow_down`.
 */
export async function pollDeviceToken(
  send: Send,
  server: string,
  authorization: DeviceAuthorization,
  resource: string,
  ctx: PollContext,
): Promise<TokenSet> {
  let interval = authorization.interval * 1000;
  const deadline = ctx.now() + authorization.expiresIn * 1000;
  while (ctx.now() < deadline) {
    await ctx.sleep(interval);
    const { status, data } = await post(send, server, 'token', {
      grant_type: DEVICE_GRANT_TYPE,
      device_code: authorization.deviceCode,
      client_id: CLI_CLIENT_ID,
      resource,
    });
    if (status === 200) {
      const tokens = tokenSet(data, ctx.now());
      if (tokens === null) {
        throw new CliError(EXIT.auth, t('login.failed', { error: 'invalid_token_response' }));
      }
      return tokens;
    }
    switch (data.error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        interval = Math.min(interval + SLOW_DOWN_S * 1000, MAX_INTERVAL_S * 1000);
        continue;
      case 'access_denied':
        throw new CliError(EXIT.auth, t('login.denied'));
      case 'expired_token':
        throw new CliError(EXIT.auth, t('login.expired'));
      default:
        throw new CliError(
          status === 429 || status >= 500 ? EXIT.network : EXIT.auth,
          t('login.failed', { error: errorCode(data, status) }),
        );
    }
  }
  throw new CliError(EXIT.auth, t('login.expired'));
}

/**
 * Exchanges the refresh token for a new pair (rotation: the old refresh token is spent).
 * `invalid_grant` is `GrantEndedError`; a server problem is exit 6, anything else exit 3.
 */
export async function refreshTokens(
  send: Send,
  server: string,
  refreshToken: string,
  resource: string,
  now: () => number,
): Promise<TokenSet> {
  const { status, data } = await post(send, server, 'token', {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLI_CLIENT_ID,
    resource,
  });
  if (status === 200) {
    const tokens = tokenSet(data, now(), refreshToken);
    if (tokens === null) {
      throw new CliError(EXIT.auth, t('auth.refreshFailed', { error: 'invalid_token_response' }));
    }
    return tokens;
  }
  if (data.error === 'invalid_grant') throw new GrantEndedError();
  throw new CliError(
    status === 429 || status >= 500 ? EXIT.network : EXIT.auth,
    t('auth.refreshFailed', { error: errorCode(data, status) }),
    status === 429 ? 'rate_limited' : status >= 500 ? 'server_error' : errorCode(data, status),
  );
}

/**
 * A refresh that may have been rotated on the server without the answer arriving: a network
 * failure, a timeout or a 5xx (never `invalid_grant`, a 4xx or a 429). The server redeems the
 * previous refresh token once more within 60 s while its successor is unused, so the same
 * refresh is sent again at once (11 §2.4).
 */
export function isLostRefresh(error: unknown): boolean {
  return (
    error instanceof CliError &&
    error.exitCode === EXIT.network &&
    (error.code === undefined || error.code === 'server_error')
  );
}

/** RFC 7009: revokes a refresh token (and with it the grant). True when the server agreed. */
export async function revokeToken(send: Send, server: string, token: string): Promise<boolean> {
  const { status } = await post(send, server, 'revoke', {
    token,
    token_type_hint: 'refresh_token',
    client_id: CLI_CLIENT_ID,
  });
  return status === 200;
}
