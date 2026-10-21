import { isCimdClientIdUrlCandidate } from '@better-auth/cimd';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { stripAccessTokenAuthorizationScheme } from 'better-auth/oauth2';
import type { Context } from 'hono';
import type { Config } from '../config.ts';
import { clientIp } from '../lib/client-ip.ts';
import type { AppEnv } from '../lib/context.ts';
import { problemResponse } from '../lib/errors.ts';
import { type RateLimitOptions, SlidingWindowLimiter } from '../lib/rate-limit.ts';
import { hashDeviceSecret } from '../services/device-codes.ts';
import {
  CLI_CLIENT_ID,
  DEVICE_CODE_GRANT_TYPE,
  OAUTH_REFRESH_PREFIX,
} from '../services/grant-service.ts';
import type { Services } from '../services/index.ts';
import type { SignInRejection } from '../services/sign-in-policy.ts';
import { AUTH_BASE_PATH, type Auth, CLIENT_IP_HEADER, IDENTITY_UNLINKED } from './auth.ts';
import { clearInviteCookie, isSecureBaseUrl } from './cookies.ts';
import { CLIENT_ID_MAX, DEVICE_AUTHORIZATION_PATH } from './device-grant.ts';
import { KeyedLock } from './keyed-lock.ts';
import { resourceOf } from './oauth-metadata.ts';

const REJECTIONS: ReadonlySet<string> = new Set<SignInRejection>([
  'not_invited',
  'account_disabled',
  'unverified_email',
  'account_link_blocked',
]);

/**
 * Post-processes OAuth callback responses: a sign-in rejected by the allowlist goes to the
 * SPA's `/not-invited` page (FR-AUTH-2); one through an identity the user unlinked goes back
 * to `/login?error=identity_unlinked`, where they can sign in another way (FR-SET-3); a
 * successful sign-in drops the consumed `rooster.invite` cookie.
 */
function rewriteCallback(res: Response, config: Config): Response {
  const location = res.headers.get('location');
  if (location === null) return res;
  const headers = new Headers(res.headers);
  const raw = new URL(location, config.baseUrl).searchParams.get('error');
  // better-auth refuses an unverified email that matches an existing account before the
  // allowlist gate runs (`account_not_linked`); an unknown one reaches the gate
  // (`unverified_email`). Answered alike, the reply does not tell whether an account exists.
  const error = raw === 'account_not_linked' ? 'unverified_email' : raw;
  if (error !== null && REJECTIONS.has(error)) {
    headers.set('location', `${config.baseUrl}/not-invited?reason=${error}`);
  } else if (error === IDENTITY_UNLINKED) {
    headers.set('location', `${config.baseUrl}/login?error=${IDENTITY_UNLINKED}`);
  } else if (error === null) {
    headers.append('set-cookie', clearInviteCookie(isSecureBaseUrl(config.baseUrl)));
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * The only better-auth endpoints a non-browser client may call: the CLI asks for a device
 * code and polls for its token before it has any credential (RFC 8628).
 */
const DEVICE_CODE_PATH = `${AUTH_BASE_PATH}/device/code`;
const DEVICE_TOKEN_PATH = `${AUTH_BASE_PATH}/device/token`;
export const DEVICE_FLOW_PATHS: ReadonlySet<string> = new Set([
  DEVICE_CODE_PATH,
  DEVICE_TOKEN_PATH,
]);

/** The OAuth provider's endpoints (ADR 0041); every other `/oauth2/*` path is a 404. */
const OAUTH_PREFIX = `${AUTH_BASE_PATH}/oauth2/`;
const OAUTH_ADMIN_PREFIX = `${AUTH_BASE_PATH}/admin/oauth2/`;
const OAUTH_AUTHORIZE_PATH = `${AUTH_BASE_PATH}/oauth2/authorize`;
const OAUTH_TOKEN_PATH = `${AUTH_BASE_PATH}/oauth2/token`;
const OAUTH_REGISTER_PATH = `${AUTH_BASE_PATH}/oauth2/register`;
const OAUTH_REVOKE_PATH = `${AUTH_BASE_PATH}/oauth2/revoke`;
/** Phase 12: the device grant's authorization endpoint (11 §9.2). */
const OAUTH_DEVICE_PATH = `${AUTH_BASE_PATH}${DEVICE_AUTHORIZATION_PATH}`;

/**
 * The OAuth endpoints a client calls directly (ADR 0041 §1): exempt from the browser-only rule.
 * They never see a cookie, and only `Authorization: Basic` (client authentication) is kept;
 * registration keeps no credential at all, so it is always the anonymous kind.
 */
export const OAUTH_CLIENT_PATHS: ReadonlySet<string> = new Set([
  OAUTH_TOKEN_PATH,
  OAUTH_REVOKE_PATH,
  OAUTH_REGISTER_PATH,
  OAUTH_DEVICE_PATH,
]);

/**
 * 11 §9.2: device authorization requests (both flows) per IP, on top of better-auth's limit on
 * `/api/auth/*`; and per third-party client (`rooster-cli` is shared by every user, so the IP
 * limit is its only one).
 */
export const DEVICE_REQUESTS_PER_IP: RateLimitOptions = { max: 10, windowMs: 10 * 60_000 };
export const DEVICE_REQUESTS_PER_CLIENT: RateLimitOptions = { max: 30, windowMs: 60 * 60_000 };

/** Parameters of the provider's signed query that a resumed authorization must not repeat. */
const SIGNED_QUERY_PARAMS = ['sig', 'exp', 'ba_iat', 'ba_pl', 'ba_param'];

/**
 * Stand-ins for a missing, repeated or foreign `resource` (RFC 8707 is optional in the provider,
 * required here). No resource row has these identifiers, so the provider answers
 * `invalid_target` the standard way: after validating the client and redirect URI, to the
 * redirect URI, with `state` and `iss` (RFC 9207).
 */
const RESOURCE_REQUIRED = 'urn:rooster:error:resource-required';
const RESOURCE_SINGLE = 'urn:rooster:error:exactly-one-resource';
const RESOURCE_UNKNOWN = 'urn:rooster:error:unknown-resource';

/** Without `scope`, the least: read, plus a refresh token. */
const DEFAULT_OAUTH_SCOPE = 'tasks:read offline_access';

/**
 * Normalises an authorization request before the provider sees it: exactly one `resource`,
 * one of rooster's two (else a stand-in the provider rejects with `invalid_target`), a default
 * `scope`, and no leftovers of a signed query (a sign-in resumes with the query it was given).
 */
function normalizeAuthorize(params: URLSearchParams, config: Config): URLSearchParams {
  const out = new URLSearchParams(params);
  for (const name of SIGNED_QUERY_PARAMS) out.delete(name);
  // No sender-constrained (DPoP) tokens: a key binding asked for up front is dropped.
  out.delete('dpop_jkt');
  const resources = out.getAll('resource');
  out.delete('resource');
  if (resources.length === 0) out.set('resource', RESOURCE_REQUIRED);
  else if (resources.length > 1) out.set('resource', RESOURCE_SINGLE);
  else if (resourceOf(config, resources[0] as string) === null)
    out.set('resource', RESOURCE_UNKNOWN);
  else out.set('resource', resources[0] as string);
  if ((out.get('scope') ?? '').trim() === '') out.set('scope', DEFAULT_OAUTH_SCOPE);
  return out;
}

/** An RFC 6749 §5.2 error from the token endpoint. */
function tokenError(
  error: string,
  description: string,
  status = 400,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      pragma: 'no-cache',
      ...extra,
    },
  });
}

function tooManyDeviceRequests(waitMs: number): Response {
  return tokenError(
    'temporarily_unavailable',
    'Too many device authorization requests; try again later.',
    429,
    { 'retry-after': String(Math.ceil(waitMs / 1000)) },
  );
}

/**
 * A token request's fields, canonical: form-encoded (RFC 6749) or a flat JSON object of
 * strings, each field at most once (a repeated `resource` is reported as such), `grant_type`
 * trimmed as the provider trims it. The provider then receives exactly these fields as a form,
 * so every check here sees what the provider acts on.
 */
function canonicalTokenFields(
  body: ArrayBuffer,
  contentType: string,
): Map<string, string> | { error: string; description: string } {
  const text = new TextDecoder().decode(body);
  const entries: [string, unknown][] = [];
  if (/^application\/x-www-form-urlencoded\b/i.test(contentType)) {
    entries.push(...new URLSearchParams(text).entries());
  } else if (/^application\/json\b/i.test(contentType)) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { error: 'invalid_request', description: 'The request body is not valid JSON.' };
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { error: 'invalid_request', description: 'Send the parameters as an object.' };
    }
    for (const [key, v] of Object.entries(value)) {
      for (const item of Array.isArray(v) ? v : [v]) entries.push([key, item]);
    }
  } else {
    return { error: 'invalid_request', description: 'Send application/x-www-form-urlencoded.' };
  }
  const fields = new Map<string, string>();
  for (const [key, value] of entries) {
    if (key === 'resource' && fields.has(key)) {
      return { error: 'invalid_target', description: 'Request one resource per token.' };
    }
    if (typeof value !== 'string' || fields.has(key)) {
      return { error: 'invalid_request', description: `Send "${key}" once, as a string.` };
    }
    fields.set(key, key === 'grant_type' ? value.trim() : value);
  }
  return fields;
}

/**
 * The provider's token response with `scope` replaced by what the grant allows now (the user
 * may have approved less than was requested, or narrowed the app since).
 */
async function withGrantScope(
  res: Response,
  grantId: string | null,
  services: Services,
): Promise<Response> {
  if (grantId === null || res.status !== 200) return res;
  const body = (await res.clone().json()) as Record<string, unknown>;
  const scope = services.grants.oauthTokenScope(grantId, typeof body.refresh_token === 'string');
  if (scope === null || typeof body.access_token !== 'string') return res;
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  return new Response(JSON.stringify({ ...body, scope }), { status: 200, headers });
}

/**
 * One refresh-token exchange at a time per grant (reuse detection and the refresh grace, ADR
 * 0041, 11 §2.4): a retry of the previous token and a use of its successor never interleave.
 */
const refreshLocks = new KeyedLock();

/**
 * `POST /api/auth/oauth2/token` (ADR 0041): DPoP is refused (bearer tokens only); the fields
 * are made canonical; a code must carry a live grant; a refresh token is checked for reuse and
 * idleness and rotated by the provider under one lock, so a concurrent second use is detected
 * as reuse; the response reports the grant's scopes.
 */
async function tokenRequest(
  init: RequestInit,
  headers: Headers,
  forward: () => Promise<Response>,
  services: Services,
): Promise<Response> {
  if (headers.has('dpop')) {
    return tokenError('invalid_dpop_proof', 'DPoP is not supported; use bearer tokens.');
  }
  const fields =
    init.body instanceof ArrayBuffer
      ? canonicalTokenFields(init.body, headers.get('content-type') ?? '')
      : { error: 'invalid_request', description: 'The request has no parameters.' };
  if (!(fields instanceof Map)) return tokenError(fields.error, fields.description);
  init.body = new URLSearchParams([...fields]).toString();
  headers.set('content-type', 'application/x-www-form-urlencoded');
  headers.delete('content-length');
  const grantType = fields.get('grant_type');
  if (grantType === 'authorization_code') {
    const code = fields.get('code');
    const check =
      code === undefined
        ? { ok: true as const, grantId: null }
        : services.grants.checkOAuthCode(code);
    if (!check.ok) return tokenError('invalid_grant', check.description);
    return withGrantScope(await forward(), check.grantId, services);
  }
  if (grantType === DEVICE_CODE_GRANT_TYPE) {
    // Phase 12 (11 §9.2): an approved code must still carry a live grant; everything else
    // (pending, slow down, denied, expired, the client and the resource) is the grant handler's.
    const code = fields.get('device_code');
    const check =
      code === undefined
        ? { ok: true as const, grantId: null }
        : services.grants.checkDeviceToken(code);
    if (!check.ok) return tokenError('invalid_grant', check.description);
    return withGrantScope(await forward(), check.grantId, services);
  }
  if (grantType === 'refresh_token') {
    const token = fields.get('refresh_token');
    if (token === undefined) return forward();
    return refreshLocks.run(services.grants.refreshLockKey(token), async () => {
      const check = services.grants.checkOAuthRefresh(token);
      if (!check.ok) return tokenError('invalid_grant', check.description);
      // A `scope` is judged against the grant, whose scopes the responses report (the provider
      // would judge it against the request's). Within the grant, the provider just reissues;
      // the response reports the grant's scopes, which are what is enforced.
      const scope = fields.get('scope');
      if (scope !== undefined && check.grantId !== null) {
        if (!services.grants.oauthScopeCovered(check.grantId, scope)) {
          if (check.grace !== undefined) services.grants.undoGrace(check.grace);
          return tokenError('invalid_scope', 'The scope is wider than this authorization.');
        }
        fields.delete('scope');
        init.body = new URLSearchParams([...fields]).toString();
      }
      // A grace retry the provider refuses (or that throws) is undone: it changes nothing.
      let res: Response | null = null;
      try {
        res = await forward();
      } finally {
        if (check.grace !== undefined && res?.status !== 200) {
          services.grants.undoGrace(check.grace);
        }
      }
      if (res.status === 200) {
        const rotated = (await res.clone().json()) as { refresh_token?: unknown };
        if (typeof rotated.refresh_token === 'string') {
          services.grants.recordRotation(token, rotated.refresh_token);
        }
      }
      return withGrantScope(res, check.grantId, services);
    });
  }
  return forward();
}

/**
 * The legacy CLI flow's `/device/token` body as single-valued fields: a form (RFC 8628 §3.4)
 * or the JSON object better-auth takes. A repeated form field is dropped (the plugin then
 * answers `invalid_request`), and so is a JSON value that is not a string.
 */
function legacyTokenFields(body: ArrayBuffer, contentType: string): Record<string, unknown> {
  const text = new TextDecoder().decode(body);
  const fields: Record<string, unknown> = {};
  if (/^application\/x-www-form-urlencoded\b/i.test(contentType)) {
    const form = new URLSearchParams(text);
    for (const key of new Set(form.keys())) {
      const values = form.getAll(key);
      if (values.length === 1) fields[key] = values[0] as string;
    }
    return fields;
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, v] of Object.entries(value)) {
        if (typeof v === 'string') fields[key] = v;
      }
    }
  } catch {
    // Not JSON: the plugin answers `invalid_request` for the empty body.
  }
  return fields;
}

/**
 * The legacy CLI flow's `/device/code` answer: better-auth stored both codes in the clear, so
 * they are replaced by their hashes (04 §4) before the answer leaves; if that fails, the codes
 * are never handed out.
 */
async function sealLegacyDeviceCodes(
  res: Response,
  ip: string | null,
  services: Services,
): Promise<Response> {
  if (res.status !== 200) return res;
  const body = (await res.clone().json()) as { device_code?: unknown; user_code?: unknown };
  if (
    typeof body.device_code !== 'string' ||
    typeof body.user_code !== 'string' ||
    !services.grants.sealLegacyDeviceRequest(body.device_code, body.user_code, ip)
  ) {
    return tokenError('server_error', 'The device code could not be stored.', 500);
  }
  return res;
}

/** RFC 7009 §2.2: the revocation answer, empty. */
function revoked(): Response {
  return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } });
}

/**
 * `POST /api/auth/oauth2/revoke` (RFC 7009) of a refresh token, serialised with the refreshes of
 * its grant. Revoking a refresh token revokes that token only (11 §9.4); a `rooster-cli` login
 * through the device grant is one grant per refresh chain, so revoking its refresh token, even a
 * stale one (`rooster logout`, 11 §9.6), ends that grant and nothing else. A stale token of any
 * other client has nothing left to revoke. The provider sees neither: for a rotated token it
 * would delete every token of the client and user (the user's other CLI logins, an app's other
 * chains).
 */
async function revokeRequest(
  body: ArrayBuffer,
  headers: Headers,
  forward: () => Promise<Response>,
  services: Services,
): Promise<Response> {
  const fields = canonicalTokenFields(body, headers.get('content-type') ?? '');
  if (!(fields instanceof Map)) return tokenError(fields.error, fields.description);
  const raw = fields.get('token');
  // Classified as the provider will read it: it drops an authorization scheme ("Bearer …") and
  // surrounding space, so `token=Bearer rooster_rt_…` names the same refresh token.
  const token = raw === undefined ? undefined : stripAccessTokenAuthorizationScheme(raw);
  if (token === undefined || !token.startsWith(OAUTH_REFRESH_PREFIX)) return forward();
  return refreshLocks.run(services.grants.refreshLockKey(token), async () => {
    const decision = services.grants.refreshRevocation(token, fields.get('client_id'));
    if (decision === null) return forward();
    if (decision.kind === 'cli') services.grants.endCliLogin(decision.grantId);
    return revoked();
  });
}

/** Headers that carry a non-browser credential (a session token as bearer, a PAT, an API key). */
const CREDENTIAL_HEADERS = ['authorization', 'x-api-key'] as const;

/**
 * better-auth's bearer plugin hands every response that sets the session cookie a
 * `set-auth-token` header. Rooster never uses it (the CLI gets its token from the device
 * flow), and it would expose the httpOnly browser session token to scripts.
 */
function withoutAuthToken(res: Response): Response {
  if (!res.headers.has('set-auth-token')) return res;
  const headers = new Headers(res.headers);
  headers.delete('set-auth-token');
  const exposed = (headers.get('access-control-expose-headers') ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h !== '' && h.toLowerCase() !== 'set-auth-token');
  if (exposed.length === 0) headers.delete('access-control-expose-headers');
  else headers.set('access-control-expose-headers', exposed.join(', '));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

const nonBrowser = (c: Context) =>
  problemResponse(
    c,
    403,
    'forbidden_scope',
    'Tokens, CLI devices and apps cannot use the sign-in endpoints; use /api/v1.',
  );

/**
 * Mounts better-auth at `/api/auth/*` (04 §4.4). Grants are enforced in `/api/v1` services,
 * so `/api/auth/*` is for the browser only (default deny): a request carrying a bearer
 * token, a PAT or an API key header is `403 forbidden_scope`, and so is a CLI device
 * session presented as a cookie. The device flow's code and token endpoints are the
 * exception; they get neither credential headers nor cookies.
 */
export function registerAuthRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: { auth: Auth; config: Config; services: Services; clock: () => number },
): void {
  const { auth, config, services, clock } = deps;
  const devicePerIp = new SlidingWindowLimiter(DEVICE_REQUESTS_PER_IP);
  const devicePerClient = new SlidingWindowLimiter(DEVICE_REQUESTS_PER_CLIENT);
  app.on(['GET', 'POST'], `${AUTH_BASE_PATH}/*`, async (c) => {
    const raw = c.req.raw;
    const path = c.req.path;
    const headers = new Headers(raw.headers);
    headers.delete(CLIENT_IP_HEADER);
    if (DEVICE_FLOW_PATHS.has(path)) {
      for (const name of CREDENTIAL_HEADERS) headers.delete(name);
      headers.delete('cookie');
    } else if (OAUTH_CLIENT_PATHS.has(path)) {
      headers.delete('cookie');
      headers.delete('x-api-key');
      const authorization = headers.get('authorization');
      if (
        path === OAUTH_REGISTER_PATH ||
        (authorization !== null && !/^basic\s/i.test(authorization))
      ) {
        headers.delete('authorization');
      }
    } else {
      if (CREDENTIAL_HEADERS.some((name) => headers.has(name))) return nonBrowser(c);
      if (headers.has('cookie')) {
        const current = await auth.api.getSession({ headers, query: { disableRefresh: true } });
        if (current !== null && services.grants.isGrantSession(current.session.id)) {
          return nonBrowser(c);
        }
      }
      // Of the provider, only authorize is reachable from the browser.
      // The provider's metadata is served filtered at the RFC 8414 path (routes/oauth.ts).
      if (
        (path.startsWith(OAUTH_PREFIX) && path !== OAUTH_AUTHORIZE_PATH) ||
        path.startsWith(OAUTH_ADMIN_PREFIX) ||
        path.startsWith(`${AUTH_BASE_PATH}/.well-known/`)
      ) {
        return problemResponse(c, 404, 'not_found', 'Not found.');
      }
    }
    const ip = clientIp(c, config);
    if (ip !== null) headers.set(CLIENT_IP_HEADER, ip);
    const deviceRequest =
      raw.method === 'POST' && (path === OAUTH_DEVICE_PATH || path === DEVICE_CODE_PATH);
    if (deviceRequest) {
      const waitMs = devicePerIp.hit(ip ?? 'unknown', clock());
      if (waitMs > 0) return tooManyDeviceRequests(waitMs);
    }
    let url = raw.url;
    const init: RequestInit = { method: raw.method, headers };
    if (raw.method !== 'GET') init.body = await raw.arrayBuffer();
    const handle = async () => withoutAuthToken(await auth.handler(new Request(url, init)));
    if (path === OAUTH_DEVICE_PATH && raw.method === 'POST') {
      const fields =
        init.body instanceof ArrayBuffer
          ? canonicalTokenFields(init.body, headers.get('content-type') ?? '')
          : { error: 'invalid_request', description: 'The request has no parameters.' };
      if (!(fields instanceof Map)) return tokenError(fields.error, fields.description);
      const clientId = fields.get('client_id');
      // Counted only for client ids the endpoint could accept (bounded, CIMD-shaped), and by
      // hash: an arbitrary id would only grow the limiter's memory.
      if (
        clientId !== undefined &&
        clientId !== CLI_CLIENT_ID &&
        clientId.length <= CLIENT_ID_MAX &&
        isCimdClientIdUrlCandidate(clientId)
      ) {
        const waitMs = devicePerClient.hit(hashDeviceSecret(clientId), clock());
        if (waitMs > 0) return tooManyDeviceRequests(waitMs);
      }
      init.body = new URLSearchParams([...fields]).toString();
      headers.set('content-type', 'application/x-www-form-urlencoded');
      headers.delete('content-length');
      return handle();
    }
    if (path === DEVICE_CODE_PATH && raw.method === 'POST') {
      return sealLegacyDeviceCodes(await handle(), ip, services);
    }
    if (path === OAUTH_REVOKE_PATH && raw.method === 'POST' && init.body instanceof ArrayBuffer) {
      return revokeRequest(init.body, headers, handle, services);
    }
    if (path === OAUTH_AUTHORIZE_PATH) {
      if (raw.method === 'GET') {
        const target = new URL(raw.url);
        target.search = normalizeAuthorize(target.searchParams, config).toString();
        url = target.toString();
      } else if (init.body instanceof ArrayBuffer) {
        const form = new URLSearchParams(new TextDecoder().decode(init.body));
        init.body = normalizeAuthorize(form, config).toString();
        headers.set('content-type', 'application/x-www-form-urlencoded');
      }
    }
    if (path === OAUTH_TOKEN_PATH) {
      return tokenRequest(init, headers, handle, services);
    }
    if (path === DEVICE_TOKEN_PATH && init.body instanceof ArrayBuffer) {
      // RFC 8628 §3.4 polls with a form body, but better-auth's token endpoint takes JSON
      // only (its code endpoint takes both). Single values only: a repeated field is invalid.
      // The stored device code is its hash (04 §4), so the presented one is hashed here.
      const fields = legacyTokenFields(init.body, headers.get('content-type') ?? '');
      if (typeof fields.device_code === 'string') {
        fields.device_code = hashDeviceSecret(fields.device_code);
      }
      init.body = JSON.stringify(fields);
      headers.set('content-type', 'application/json');
      headers.delete('content-length');
    }
    const res = await handle();
    return c.req.path.startsWith(`${AUTH_BASE_PATH}/callback/`)
      ? rewriteCallback(res, config)
      : res;
  });
}
