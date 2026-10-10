import { apiKey } from '@better-auth/api-key';
import { cimd } from '@better-auth/cimd';
import { oauthProvider } from '@better-auth/oauth-provider';
import { ALL_GRANT_SCOPES, isGrantScope, OAUTH_EXCLUDED_SCOPES } from '@rooster/core/grants';
import { uuidv7 } from '@rooster/core/ids';
import { isLocale } from '@rooster/i18n';
import { type BetterAuthPlugin, betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { bearer } from 'better-auth/plugins/bearer';
import {
  type DeviceAuthorizationGrant,
  deviceAuthorization,
} from 'better-auth/plugins/device-authorization';
import { genericOAuth } from 'better-auth/plugins/generic-oauth';
import { type Config, GOOGLE_PROVIDER_ID } from '../config.ts';
import type { AppDb } from '../db/client.ts';
import {
  account,
  apikey,
  deviceCode,
  oauthAccessToken,
  oauthClient,
  oauthClientAssertion,
  oauthClientResource,
  oauthConsent,
  oauthRefreshToken,
  oauthResource,
  session,
  user,
  verification,
} from '../db/schema/index.ts';
import { localeFromAcceptLanguage, type ServerTextKey, serverText } from '../lib/i18n.ts';
import type { Logger } from '../lib/logger.ts';
import {
  CLI_CLIENT_ID,
  OAUTH_ACCESS_PREFIX,
  OAUTH_REFRESH_PREFIX,
  PAT_PREFIX,
} from '../services/grant-service.ts';
import type { Services } from '../services/index.ts';
import type { SignInRejection } from '../services/sign-in-policy.ts';
import { AUTH_BASE_PATH } from './auth-paths.ts';
import { createCimdFetch } from './cimd-fetch.ts';
import { authCookieName, readInviteToken, sessionCookieName } from './cookies.ts';
import { consentReferenceId } from './oauth-handoff.ts';

export { AUTH_BASE_PATH };

/** Set by the `/api/auth/*` mount from the socket (or a trusted proxy); never from clients. */
export const CLIENT_IP_HEADER = 'x-rooster-client-ip';

const DAY_SECONDS = 86_400;

/** The capabilities an OAuth client may be granted (ADR 0041, `OAUTH_EXCLUDED_SCOPES`). */
export const OAUTH_GRANT_SCOPES = ALL_GRANT_SCOPES.filter(
  (s) => !OAUTH_EXCLUDED_SCOPES.includes(s),
);

/** The longest `scope` a device code request may carry. */
const DEVICE_SCOPE_MAX_BYTES = 512;

/**
 * better-auth paths rooster replaces or must not expose. Device approval goes through
 * `/api/v1/device/:userCode/*` so it carries a grant (ADR 0036 §6); PATs are minted only by
 * `POST /api/v1/me/tokens`, so an API key without a grant never exists.
 */
const DISABLED_PATHS = [
  '/update-user',
  '/delete-user',
  '/change-email',
  '/device',
  '/device/approve',
  '/device/deny',
  '/api-key/create',
  '/api-key/verify',
  '/api-key/get',
  '/api-key/update',
  '/api-key/delete',
  '/api-key/list',
  '/api-key/delete-all-expired-api-keys',
  // Linked identities are listed and removed through `/api/v1/me/identities` (IdentityService);
  // an identity joins only by signing in (FR-AUTH-5). better-auth's own account endpoints would
  // link without the email-authority check (`/link-social` with an ID token never calls
  // `validateUserInfo`), unlink without rooster's rules, or hand stored provider tokens to
  // scripts (`/get-access-token` returns a replayable ID token).
  '/list-accounts',
  '/link-social',
  '/unlink-account',
  '/get-access-token',
  '/refresh-token',
  '/account-info',
  // Sessions are listed and revoked through `/api/v1/me/sessions` (UserService), without their
  // tokens; better-auth's list returns every session's token, CLI device bearer tokens included,
  // and its get and update return the browser's own (httpOnly) session token to scripts. The
  // server reads sessions through `auth.api.getSession`, which this list does not affect.
  '/list-sessions',
  '/get-session',
  '/update-session',
  // The OAuth provider (ADR 0041): rooster answers consent through `/api/v1/oauth/consent`
  // (server-side `auth.api.oauth2Consent`); introspection, UserInfo, client and consent CRUD,
  // resource admin, prelogin, continue and end-session are not offered. The mount allows only
  // authorize, token, revoke and (with DCR) register under `/oauth2/` (auth/mount.ts).
  '/oauth2/consent',
  '/oauth2/continue',
  '/oauth2/introspect',
  '/oauth2/userinfo',
  '/oauth2/end-session',
  '/oauth2/end-session/confirm',
  '/oauth2/create-client',
  '/oauth2/get-client',
  '/oauth2/public-client',
  '/oauth2/public-client-prelogin',
  '/oauth2/get-clients',
  '/oauth2/update-client',
  '/oauth2/client/rotate-secret',
  '/oauth2/delete-client',
  '/oauth2/get-consent',
  '/oauth2/get-consents',
  '/oauth2/update-consent',
  '/oauth2/delete-consent',
  '/admin/oauth2/create-client',
  '/admin/oauth2/update-client',
  '/admin/oauth2/resources',
];

/** Access tokens live 15 minutes (11 §2.4); the grant is read on every request anyway. */
export const OAUTH_ACCESS_TOKEN_TTL_S = 15 * 60;

/** The SPA routes the provider sends the browser to (11 §3.1). */
export const OAUTH_CONSENT_PATH = '/oauth/consent';
export const OAUTH_LOGIN_PATH = '/login';

/**
 * Scopes OAuth clients may request: the user capabilities minus `OAUTH_EXCLUDED_SCOPES`, plus
 * `offline_access` for a refresh token. Never `openid`: with a nonce it waives PKCE.
 */
export const OAUTH_SCOPES: readonly string[] = [...OAUTH_GRANT_SCOPES, 'offline_access'];

/**
 * The grant ID of the approved device code being redeemed, by endpoint context: set by the
 * device plugin's `assertSessionRedemption` (while the code still exists) and read by the
 * session create hook of the same `/device/token` request (the plugin then has consumed it).
 */
const redeemedGrant = new WeakMap<object, string>();

function deviceError(error: string, description: string): APIError {
  return new APIError('BAD_REQUEST', { error, error_description: description });
}

/**
 * The callback error for an identity the user unlinked (FR-SET-3): the auth mount sends the
 * browser to `/login?error=identity_unlinked`.
 */
export const IDENTITY_UNLINKED = 'identity_unlinked';

/**
 * The provider subject of a sign-in, as better-auth derives the account ID for rooster's
 * providers (Google and OIDC: the `sub` claim). Only an early check; the account create hook
 * compares the real account ID.
 */
function profileSubject(profile: unknown): string | null {
  const sub = (profile as { sub?: unknown } | null | undefined)?.sub;
  return typeof sub === 'string' && sub !== '' ? sub : null;
}

const REJECTION_TEXT: Record<SignInRejection, ServerTextKey> = {
  not_invited: 'signIn.notInvited',
  account_disabled: 'signIn.disabled',
  unverified_email: 'signIn.unverifiedEmail',
  account_link_blocked: 'signIn.accountLinkBlocked',
};

export interface AuthDeps {
  config: Config;
  db: AppDb;
  logger: Logger;
  services: Services;
  clock: () => number;
  /** better-auth's limiter on `/api/auth/*` (30 requests/min per IP). Default on. */
  rateLimit?: boolean | undefined;
  /** The CIMD transport (default: the guarded fetch of `cimd-fetch.ts`); tests inject one. */
  cimdFetch?:
    | ((input: string | URL | Request, init?: RequestInit) => Promise<Response>)
    | undefined;
}

/** Endpoint context headers; better-auth passes `null` for calls outside a request. */
function headersOf(ctx: { headers?: Headers | undefined; request?: Request | undefined } | null) {
  return ctx?.headers ?? ctx?.request?.headers ?? null;
}

/**
 * Providers whose verified email is proof of owning the address: the built-in Google provider
 * when it is configured, plus every OIDC provider configured with `trustEmail` (FR-AUTH-5).
 * Only these may join an existing account by email. A generic OIDC provider that happens to be
 * called `google` is trusted only through its own `trustEmail`.
 */
export function emailAuthorities(config: Config): ReadonlySet<string> {
  return new Set([
    ...(config.google === null ? [] : [GOOGLE_PROVIDER_ID]),
    ...config.oidcProviders.filter((p) => p.trustEmail).map((p) => p.id),
  ]);
}

/**
 * Sign-in sends the browser to the provider (a code flow with PKCE and a nonce). An ID token
 * posted by the client (`/sign-in/social` with `idToken`) is refused: rooster never uses it,
 * and it would turn any provider ID token a script obtained into a session.
 */
const refuseClientIdTokens = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== '/sign-in/social') return;
  const body = ctx.body as { idToken?: unknown } | undefined;
  if (body?.idToken !== undefined) {
    throw new APIError('BAD_REQUEST', {
      code: 'ID_TOKEN_NOT_SUPPORTED',
      message: 'Sign in through the provider instead.',
    });
  }
});

/** Sign-in providers as advertised by `/api/v1/meta` and the login page. */
export function configuredProviders(config: Config): { id: string; name: string }[] {
  return [
    ...(config.google === null ? [] : [{ id: GOOGLE_PROVIDER_ID, name: 'Google' }]),
    ...config.oidcProviders.map((p) => ({ id: p.id, name: p.name })),
  ];
}

/** Origins the browser is sent to when sign-in starts (CSP `form-action`, 04 §4.11). */
export function providerOrigins(config: Config): string[] {
  const origins = config.oidcProviders.map((p) => new URL(p.discoveryUrl).origin);
  if (config.google !== null) origins.unshift('https://accounts.google.com');
  return [...new Set(origins)];
}

/**
 * The better-auth instance (04 §4.4, ADR 0002): authentication only. Orgs are rooster's
 * own tables, so the organization plugin is not used.
 */
export function createAuth(deps: AuthDeps) {
  const { config, db, logger, services, clock } = deps;
  const secure = config.baseUrl.startsWith('https://');
  const authLogger = logger.child({ component: 'better-auth' });
  const linkableProviders = emailAuthorities(config);
  const inviteTokenOf = (headers: Headers | null) =>
    readInviteToken(headers?.get('cookie'), config.authSecret, clock(), secure);
  const rejection = (headers: Headers | null, reason: SignInRejection) => ({
    error: reason,
    errorDescription: serverText(
      localeFromAcceptLanguage(headers?.get('accept-language')),
      REJECTION_TEXT[reason],
    ),
  });
  const identityUnlinked = (headers: Headers | null) => ({
    error: IDENTITY_UNLINKED,
    errorDescription: serverText(
      localeFromAcceptLanguage(headers?.get('accept-language')),
      'signIn.identityUnlinked',
    ),
  });

  const deviceGrant: DeviceAuthorizationGrant = {
    requestSchemaFields: {},
    deviceCodeSchemaFields: {
      grantId: { type: 'string', required: false, input: false },
      userAgent: { type: 'string', required: false, input: false },
    },
    authorizeRequest: ({ ctx, request }) => {
      if (request.client_id !== CLI_CLIENT_ID) {
        throw deviceError('invalid_client', 'Unknown client ID.');
      }
      const raw = request.scope ?? '';
      if (Buffer.byteLength(raw) > DEVICE_SCOPE_MAX_BYTES) {
        throw deviceError('invalid_scope', 'The scope is too long.');
      }
      const scopes = raw.split(/\s+/).filter((s) => s !== '');
      if (scopes.some((s) => !isGrantScope(s))) {
        throw deviceError('invalid_scope', 'Unknown scope requested.');
      }
      // Stored canonical (known scopes, once each, in contract order); the plugin persists
      // `request.scope` after this hook. `admin` is accepted here and dropped at approval for
      // anyone who is not an instance admin (ADR 0042 §1).
      const canonical = ALL_GRANT_SCOPES.filter((s) => scopes.includes(s)).join(' ');
      request.scope = canonical === '' ? undefined : canonical;
      const userAgent = ctx.request?.headers.get('user-agent')?.slice(0, 200) ?? null;
      return { clientId: CLI_CLIENT_ID, deviceCodeFields: { userAgent } };
    },
    assertSessionRedemption: ({ ctx, deviceCode: code }) => {
      if (code.status === 'approved' && typeof code.grantId === 'string') {
        redeemedGrant.set(ctx, code.grantId);
      }
    },
    getVerificationContext: () => undefined,
  };

  services.grants.seedOAuthResources(OAUTH_ACCESS_TOKEN_TTL_S);

  return betterAuth({
    appName: 'rooster',
    baseURL: config.baseUrl,
    basePath: AUTH_BASE_PATH,
    secret: config.authSecret,
    trustedOrigins: [config.baseUrl],
    telemetry: { enabled: false },
    logger: {
      level: 'warn',
      log: (level, message, ...args) => {
        const fields = args.length > 0 ? { args } : {};
        if (level === 'error') authLogger.error(fields, message);
        else if (level === 'warn') authLogger.warn(fields, message);
        else authLogger.debug(fields, message);
      },
    },
    database: drizzleAdapter(db.orm, {
      provider: 'sqlite',
      schema: {
        user,
        session,
        account,
        verification,
        apikey,
        deviceCode,
        oauthClient,
        oauthResource,
        oauthClientResource,
        oauthRefreshToken,
        oauthAccessToken,
        oauthConsent,
        oauthClientAssertion,
      },
    }),
    // Users change their profile through PATCH /api/v1/me; accounts are never deleted.
    disabledPaths: DISABLED_PATHS,
    socialProviders:
      config.google === null
        ? {}
        : {
            google: {
              clientId: config.google.clientId,
              clientSecret: config.google.clientSecret,
              prompt: 'select_account',
            },
          },
    plugins: [
      ...(config.oidcProviders.length === 0
        ? []
        : [
            genericOAuth({
              config: config.oidcProviders.map((p) => ({
                providerId: p.id,
                name: p.name,
                discoveryUrl: p.discoveryUrl,
                clientId: p.clientId,
                clientSecret: p.clientSecret,
                scopes: p.scopes ?? ['openid', 'email', 'profile'],
                pkce: true,
                requireIdTokenVerification: true,
              })),
            }),
          ]),
      // `Authorization: Bearer <session token>` (CLI device sessions, 04 §4.4).
      bearer(),
      // RFC 8628 for the CLI (07 §2): `/device/code` and `/device/token` stay better-auth's;
      // approval is rooster's (DISABLED_PATHS). The `grant` extension validates the request
      // and hands the approved code's grant to the session its redemption creates.
      deviceAuthorization({
        expiresIn: '10m',
        interval: '5s',
        verificationUri: `${config.baseUrl}/device`,
        grant: deviceGrant,
      }),
      // PATs (04 §4.4): rows of the plugin's `apikey` table, minted by GrantService and
      // verified by hash in the actor middleware. Its HTTP endpoints are disabled.
      apiKey({
        defaultPrefix: PAT_PREFIX,
        enableMetadata: true,
        maximumNameLength: 100,
        rateLimit: { enabled: false },
      }),
      // The OAuth 2.1 authorization server (11 §4, ADR 0041). Opaque, hashed, prefixed tokens;
      // authorization code + PKCE (S256) and refresh tokens only; the rooster grant rides on
      // every code, token and consent as `referenceId` (oauth-handoff.ts). The mount adds what
      // the plugin leaves optional: `resource` required, refresh reuse revokes the grant.
      // Typed as a plain plugin: its endpoint metadata does not satisfy
      // `exactOptionalPropertyTypes`. Its server-side API is `OAuthProviderApi` below.
      oauthProvider({
        loginPage: `${config.baseUrl}${OAUTH_LOGIN_PATH}`,
        consentPage: `${config.baseUrl}${OAUTH_CONSENT_PATH}`,
        scopes: [...OAUTH_SCOPES],
        clientRegistrationDefaultScopes: [...OAUTH_SCOPES],
        advertisedMetadata: { scopes_supported: [...OAUTH_SCOPES] },
        grantTypes: ['authorization_code', 'refresh_token'],
        disableJwtPlugin: true,
        storeTokens: 'hashed',
        prefix: {
          opaqueAccessToken: OAUTH_ACCESS_PREFIX,
          refreshToken: OAUTH_REFRESH_PREFIX,
        },
        accessTokenExpiresIn: OAUTH_ACCESS_TOKEN_TTL_S,
        refreshTokenReuseInterval: 0,
        // The two resources are rows seeded by `seedOAuthResources` (synchronously, so no
        // background seeding outlives a closed database). Every client may ask for either; the
        // user consents per request.
        enforcePerClientResources: false,
        allowDynamicClientRegistration: config.oauthDcr,
        allowUnauthenticatedClientRegistration: config.oauthDcr,
        postLogin: {
          page: `${config.baseUrl}${OAUTH_CONSENT_PATH}`,
          shouldRedirect: () => false,
          consentReferenceId: ({ user: u }) =>
            consentReferenceId(u?.id, (userId, clientId) =>
              services.grants.liveOAuthGrantId(userId, clientId),
            ),
        },
      }) as unknown as BetterAuthPlugin,
      // Client ID Metadata Documents (11 §4.2): fetched through the IP-based guard.
      cimd({
        fetchClientMetadataResource: deps.cimdFetch ?? createCimdFetch(),
        metadataProfile: 'mcp-2026-07-28',
        metadataRevalidationInterval: '24h',
      }) as unknown as BetterAuthPlugin,
    ],
    user: {
      additionalFields: {
        locale: { type: 'string', required: false, defaultValue: 'en', input: false },
        timezone: { type: 'string', required: false, defaultValue: 'UTC', input: false },
        weekStart: { type: 'number', required: false, defaultValue: 1, input: false },
        dateFormat: { type: 'string', required: false, defaultValue: 'MMM d', input: false },
        timeFormat: { type: 'string', required: false, defaultValue: '24h', input: false },
        prefs: { type: 'string', required: false, defaultValue: '{}', input: false },
        disabledAt: { type: 'number', required: false, input: false, returned: false },
      },
      // The allowlist gate (FR-AUTH-2). better-auth calls it before creating a user (so a
      // rejected sign-in leaves no user row, AC-1.1), on every sign-in of an existing user
      // and before linking another identity. A rejection redirects to the error URL with
      // `?error=<reason>`, which the auth mount rewrites to /not-invited.
      validateUserInfo: async ({ user: info, source }, ctx) => {
        const headers = headersOf(ctx);
        // better-auth links any provider that calls the email verified. A provider that is
        // not authoritative for the address could take over the account of whoever owns
        // it, so only email authorities may link (by email, or explicitly).
        const providerId = source.oauth?.providerId ?? source.sso?.providerId;
        // An identity the user unlinked stays out until they allow it again (FR-SET-3). The
        // account create hook below is the authoritative check; this one runs before a new
        // user row exists, so a removed identity whose email now matches no account leaves
        // nothing behind either.
        const subject = profileSubject(source.oauth?.profile);
        if (
          source.action !== 'sign-in' &&
          providerId !== undefined &&
          subject !== null &&
          services.identities.isBlocked(providerId, subject)
        ) {
          authLogger.warn({ providerId }, 'sign-in refused: identity was unlinked');
          return identityUnlinked(headers);
        }
        if (
          source.action === 'link-account' &&
          (providerId === undefined || !linkableProviders.has(providerId))
        ) {
          authLogger.warn({ providerId }, 'account link refused: provider not trusted for email');
          return rejection(headers, 'account_link_blocked');
        }
        const decision = services.signIn.check({
          email: String(info.email ?? ''),
          emailVerified: info.emailVerified === true,
          userId: source.action === 'create-user' ? undefined : String(info.id),
          inviteToken: inviteTokenOf(headers),
        });
        return decision.ok ? undefined : rejection(headers, decision.reason);
      },
    },
    account: {
      // FR-AUTH-5: another identity with the same *verified* email joins the account, when
      // its provider is an email authority (validateUserInfo enforces that).
      accountLinking: { enabled: true, requireLocalEmailVerified: true },
      encryptOAuthTokens: true,
    },
    session: {
      // A CLI device session points at its grant (11 §2.4); the browser's is null.
      additionalFields: {
        grantId: { type: 'string', required: false, input: false, returned: false },
      },
      expiresIn: 30 * DAY_SECONDS,
      updateAge: DAY_SECONDS,
      // Off, so a revoked session or a disabled user is rejected on the next request (AC-1.7).
      cookieCache: { enabled: false },
    },
    databaseHooks: {
      account: {
        create: {
          // Every way better-auth attaches an identity (a new user, linking by email, an
          // explicit link) creates an `account` row through here. An identity the user
          // unlinked may not come back until they allow it again (FR-SET-3); the thrown
          // error ends the sign-in before any session exists.
          before: async (data, ctx) => {
            if (services.identities.isBlocked(data.providerId, data.accountId)) {
              authLogger.warn(
                { providerId: data.providerId },
                'account link refused: identity was unlinked',
              );
              const { error, errorDescription } = identityUnlinked(headersOf(ctx));
              throw new APIError('FORBIDDEN', { code: error, message: errorDescription });
            }
          },
        },
      },
      user: {
        create: {
          // The UI language comes from the browser that completes the first sign-in.
          before: async (data, ctx) => ({
            data: {
              ...data,
              locale: localeFromAcceptLanguage(headersOf(ctx)?.get('accept-language')),
            },
          }),
          after: async (created) => {
            const locale = isLocale(created.locale) ? created.locale : 'en';
            services.orgs.bootstrapPersonalOrg(created.id, locale);
          },
        },
        update: {
          // P10 (FR-SET-1): an uploaded avatar survives any profile update better-auth makes.
          after: async (updated) => {
            services.avatars.keepUploaded(updated.id);
          },
        },
      },
      session: {
        create: {
          before: async (data, ctx) => {
            // Defence in depth: validateUserInfo already rejects disabled users.
            if (services.signIn.isDisabled(data.userId)) return false;
            // A device code redeemed for a session: the session carries the grant its
            // approval created. Without a live grant there is no session (never full access).
            if (ctx?.path === '/device/token') {
              const grantId = services.grants.liveDeviceGrant(redeemedGrant.get(ctx), data.userId);
              if (grantId === null) {
                throw deviceError('access_denied', 'The approval was revoked; log in again.');
              }
              return { data: { ...data, grantId } };
            }
            // Signing in through a claimed invite joins the org (06 §2.2). validateUserInfo
            // only checked that the invite was usable; two sign-ins through one single-use
            // link can both pass that check. Accepting is atomic, so exactly one of them
            // joins, and a sign-in the invite did not carry must stand on its own.
            const headers = headersOf(ctx);
            const token = inviteTokenOf(headers);
            if (token === null) return;
            if (services.orgs.acceptInviteOnSignIn(data.userId, token) !== null) return;
            if (services.signIn.admitsExisting(data.userId)) return;
            const { error, errorDescription } = rejection(headers, 'not_invited');
            throw new APIError('FORBIDDEN', { code: error, message: errorDescription });
          },
          after: async (created) => {
            // Normally done when the user was created; repairs a failed bootstrap.
            services.orgs.bootstrapPersonalOrg(created.userId);
          },
        },
        delete: {
          // Sign-out (or an expired session cleaned up by better-auth) ends that session's
          // event streams at once (04 §4.5).
          after: async (deleted) => {
            services.events.publish({
              type: 'session.ended',
              orgId: null,
              actorId: deleted.userId,
              origin: null,
              subjects: [deleted.id],
              audiences: [],
            });
          },
        },
      },
    },
    hooks: { before: refuseClientIdTokens },
    onAPIError: { errorURL: `${config.baseUrl}/login` },
    rateLimit: { enabled: deps.rateLimit ?? true, window: 60, max: 30, storage: 'memory' },
    advanced: {
      cookiePrefix: 'rooster',
      // better-auth's own `__Secure-` prefix stays off: on https every cookie it sets is
      // `__Host-` prefixed instead (auth/cookies.ts), so a sibling subdomain can neither plant
      // nor shadow it. That matters beyond the session: a planted `state` cookie of the
      // attacker's own pending sign-in would complete it in the victim's browser (login CSRF).
      useSecureCookies: false,
      cookies: {
        session_token: { name: sessionCookieName(secure) },
        state: { name: authCookieName('state', secure) },
        oauth_state: { name: authCookieName('oauth_state', secure) },
        session_data: { name: authCookieName('session_data', secure) },
        account_data: { name: authCookieName('account_data', secure) },
        dont_remember: { name: authCookieName('dont_remember', secure) },
      },
      defaultCookieAttributes: { secure, sameSite: 'lax', httpOnly: true, path: '/' },
      database: { generateId: () => uuidv7() },
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * The OAuth provider's server-side endpoints rooster calls (its plugin is typed as a plain
 * `BetterAuthPlugin` above, so `auth.api` does not list them).
 */
export interface OAuthProviderApi {
  oauth2Consent(input: {
    headers: Headers;
    /** The provider's authorize step needs a request (only its headers are read). */
    request: Request;
    body: { accept: boolean; scope?: string; oauth_query: string };
  }): Promise<unknown>;
  getOAuthServerConfig(): Promise<unknown>;
}

export function oauthProviderApi(auth: Auth): OAuthProviderApi {
  return auth.api as unknown as OAuthProviderApi;
}
