import { apiKey } from '@better-auth/api-key';
import { isGrantScope } from '@rooster/core/grants';
import { uuidv7 } from '@rooster/core/ids';
import { isLocale } from '@rooster/i18n';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError } from 'better-auth/api';
import { bearer } from 'better-auth/plugins/bearer';
import {
  type DeviceAuthorizationGrant,
  deviceAuthorization,
} from 'better-auth/plugins/device-authorization';
import { genericOAuth } from 'better-auth/plugins/generic-oauth';
import { type Config, GOOGLE_PROVIDER_ID } from '../config.ts';
import type { AppDb } from '../db/client.ts';
import { account, apikey, deviceCode, session, user, verification } from '../db/schema/index.ts';
import { localeFromAcceptLanguage, type ServerTextKey, serverText } from '../lib/i18n.ts';
import type { Logger } from '../lib/logger.ts';
import { CLI_CLIENT_ID, PAT_PREFIX } from '../services/grant-service.ts';
import type { Services } from '../services/index.ts';
import type { SignInRejection } from '../services/sign-in-policy.ts';
import { readInviteToken, sessionCookieName } from './cookies.ts';

export const AUTH_BASE_PATH = '/api/auth';

/** Set by the `/api/auth/*` mount from the socket (or a trusted proxy); never from clients. */
export const CLIENT_IP_HEADER = 'x-rooster-client-ip';

const DAY_SECONDS = 86_400;

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
];

/**
 * The grant ID of the approved device code being redeemed, by endpoint context: set by the
 * device plugin's `assertSessionRedemption` (while the code still exists) and read by the
 * session create hook of the same `/device/token` request (the plugin then has consumed it).
 */
const redeemedGrant = new WeakMap<object, string>();

function deviceError(error: string, description: string): APIError {
  return new APIError('BAD_REQUEST', { error, error_description: description });
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
}

/** Endpoint context headers; better-auth passes `null` for calls outside a request. */
function headersOf(ctx: { headers?: Headers | undefined; request?: Request | undefined } | null) {
  return ctx?.headers ?? ctx?.request?.headers ?? null;
}

/**
 * Providers whose verified email is proof of owning the address: Google, plus every OIDC
 * provider configured with `trustEmail` (FR-AUTH-5). Only these may join an existing
 * account by email.
 */
export function emailAuthorities(config: Config): ReadonlySet<string> {
  return new Set([
    GOOGLE_PROVIDER_ID,
    ...config.oidcProviders.filter((p) => p.trustEmail).map((p) => p.id),
  ]);
}

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
      const scopes = (request.scope ?? '').split(/\s+/).filter((s) => s !== '');
      if (scopes.some((s) => !isGrantScope(s))) {
        throw deviceError('invalid_scope', 'Unknown scope requested.');
      }
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
      schema: { user, session, account, verification, apikey, deviceCode },
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
    onAPIError: { errorURL: `${config.baseUrl}/login` },
    rateLimit: { enabled: deps.rateLimit ?? true, window: 60, max: 30, storage: 'memory' },
    advanced: {
      cookiePrefix: 'rooster',
      // better-auth's own `__Secure-` prefix stays off: the session cookie is named
      // `__Host-rooster.session` on https and `rooster.session` on http (auth/cookies.ts).
      useSecureCookies: false,
      cookies: { session_token: { name: sessionCookieName(secure) } },
      defaultCookieAttributes: { secure, sameSite: 'lax', httpOnly: true, path: '/' },
      database: { generateId: () => uuidv7() },
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
