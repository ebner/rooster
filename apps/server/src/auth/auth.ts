import { uuidv7 } from '@rooster/core/ids';
import { isLocale } from '@rooster/i18n';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { genericOAuth } from 'better-auth/plugins/generic-oauth';
import { type Config, GOOGLE_PROVIDER_ID } from '../config.ts';
import type { AppDb } from '../db/client.ts';
import { account, session, user, verification } from '../db/schema/index.ts';
import { localeFromAcceptLanguage, type ServerTextKey, serverText } from '../lib/i18n.ts';
import type { Logger } from '../lib/logger.ts';
import type { Services } from '../services/index.ts';
import type { SignInRejection } from '../services/sign-in-policy.ts';
import { readInviteToken, SESSION_COOKIE } from './cookies.ts';

export const AUTH_BASE_PATH = '/api/auth';

/** Set by the `/api/auth/*` mount from the socket (or a trusted proxy); never from clients. */
export const CLIENT_IP_HEADER = 'x-rooster-client-ip';

const DAY_SECONDS = 86_400;

const REJECTION_TEXT: Record<SignInRejection, ServerTextKey> = {
  not_invited: 'signIn.notInvited',
  account_disabled: 'signIn.disabled',
  unverified_email: 'signIn.unverifiedEmail',
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
      schema: { user, session, account, verification },
    }),
    // Users change their profile through PATCH /api/v1/me; accounts are never deleted.
    disabledPaths: ['/update-user', '/delete-user', '/change-email'],
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
    plugins:
      config.oidcProviders.length === 0
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
        const decision = services.signIn.check({
          email: String(info.email ?? ''),
          emailVerified: info.emailVerified === true,
          userId: source.action === 'create-user' ? undefined : String(info.id),
          inviteToken: readInviteToken(headers?.get('cookie'), config.authSecret, clock()),
        });
        if (decision.ok) return;
        const locale = localeFromAcceptLanguage(headers?.get('accept-language'));
        return {
          error: decision.reason,
          errorDescription: serverText(locale, REJECTION_TEXT[decision.reason]),
        };
      },
    },
    account: {
      // FR-AUTH-5: another identity with the same *verified* email joins the account.
      accountLinking: { enabled: true, requireLocalEmailVerified: true },
      encryptOAuthTokens: true,
    },
    session: {
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
          // Defence in depth: validateUserInfo already rejects disabled users.
          before: async (data) => (services.signIn.isDisabled(data.userId) ? false : undefined),
          after: async (created, ctx) => {
            // Normally done when the user was created; repairs a failed bootstrap.
            services.orgs.bootstrapPersonalOrg(created.userId);
            // Signing in through a claimed invite joins the org (06 §2.2).
            const token = readInviteToken(
              headersOf(ctx)?.get('cookie'),
              config.authSecret,
              clock(),
            );
            if (token !== null) services.orgs.acceptInviteOnSignIn(created.userId, token);
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
      // Exactly `rooster.session` (no `__Secure-` prefix); Secure is set on https.
      useSecureCookies: false,
      cookies: { session_token: { name: SESSION_COOKIE } },
      defaultCookieAttributes: { secure, sameSite: 'lax', httpOnly: true, path: '/' },
      database: { generateId: () => uuidv7() },
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
