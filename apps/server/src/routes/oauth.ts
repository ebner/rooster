import { verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import { OAUTH_QUERY_MAX } from '@rooster/core/limits';
import type { Context } from 'hono';
import { OAUTH_SCOPES, oauthProviderApi } from '../auth/auth.ts';
import { DEVICE_AUTHORIZATION_PATH } from '../auth/device-grant.ts';
import { KeyedLock } from '../auth/keyed-lock.ts';
import { consentHandoff } from '../auth/oauth-handoff.ts';
import { oauthIssuer, protectedResourceMetadata } from '../auth/oauth-metadata.ts';
import type { AppEnv } from '../lib/context.ts';
import { AppError } from '../lib/errors.ts';
import { logSafeError } from '../lib/log-safe-error.ts';
import { DEVICE_CODE_GRANT_TYPE } from '../services/grant-service.ts';
import { AUTHED, actorOf, body, json, problems } from './common.ts';
import type { P9RouteDeps } from './p9-deps.ts';
import {
  OAuthClientInfoSchema,
  OAuthConsentDecisionSchema,
  OAuthConsentRequestSchema,
  OAuthConsentResultSchema,
} from './schemas-grants.ts';

// P9 WP 9.3 (11 §3.1, §4, ADR 0041): the consent screen's API, and the OAuth discovery
// documents for `/api/v1` and the authorization server. Authorisation is in GrantService.

const tags = ['me'];

/** Fields of the provider's signed query that are not part of the authorization request. */
const SIGNATURE_FIELDS = ['sig', 'exp', 'ba_iat', 'ba_pl', 'ba_param'];

const consentNotFound = () =>
  new AppError(
    'not_found',
    404,
    'That authorization request is unknown or has expired. Start again in the app.',
  );

/** The authorization request of a signed `oauth_query`; null when its signature or expiry fails. */
async function verifiedQuery(oauthQuery: string, secret: string): Promise<URLSearchParams | null> {
  if (oauthQuery.length > OAUTH_QUERY_MAX || !(await verifyOAuthQueryParams(oauthQuery, secret))) {
    return null;
  }
  const params = new URLSearchParams(oauthQuery);
  for (const name of SIGNATURE_FIELDS) params.delete(name);
  return params;
}

const oauthQueryParam = z
  .string()
  .min(1)
  .max(OAUTH_QUERY_MAX)
  .openapi({
    param: { name: 'oauth_query', in: 'query' },
    description: 'The query string the provider sent the browser to `/oauth/consent` with.',
  });

const getConsent = createRoute({
  method: 'get',
  path: '/api/v1/oauth/consent',
  tags,
  operationId: 'getOAuthConsent',
  summary: 'What an app asks for, before the user allows it',
  description:
    'Browser session only. The authorization request behind the consent screen (`/oauth/consent`): the app, its redirect target, the resource, the requested capabilities (`newScopes`: those the existing grant lacks), the existing grant on step-up, and any `authorization_details` pre-fill. An unsigned, altered or expired query (10 minutes), or `authorization_details` that are malformed or name nothing that still exists, is `404`. `decisionNonce` binds the decision to this user and session.',
  request: { query: z.object({ oauth_query: oauthQueryParam }) },
  responses: { 200: json(OAuthConsentRequestSchema, 'The request'), ...problems(401, 404) },
});

const postConsent = createRoute({
  method: 'post',
  path: '/api/v1/oauth/consent',
  tags,
  operationId: 'decideOAuthConsent',
  summary: 'Allow or deny an app',
  description:
    'Browser session only. `decisionNonce` is the one `GET /oauth/consent` returned to this user and session; any other (e.g. after switching accounts) is `404`: load the request again. Allow creates or updates my grant for the app (scopes no wider than requested; constraints no wider than the app’s `authorization_details`, else `422 widening_not_allowed`; `tasks:delete` only when requested and approved; `sessionOnly` ends it after a day without use) and answers the authorization request; Deny answers `access_denied`. Approving nothing at all is `422 nothing_approved`. Either way `redirectTo` is where the browser goes next: the app’s redirect URI with `code` or `error`, `state` and `iss`.',
  request: { body: body(OAuthConsentDecisionSchema) },
  responses: {
    200: json(OAuthConsentResultSchema, 'Where to send the browser'),
    ...problems(...AUTHED, 404, 'nothing_approved', 'widening_not_allowed'),
  },
});

/**
 * The URL in the provider's `{redirect, url}` answer (a JSON `Response` when called with a
 * request, as here).
 */
async function redirectUrl(result: unknown): Promise<string | null> {
  const value = result instanceof Response ? ((await result.json()) as unknown) : result;
  const url = (value as { url?: unknown } | null)?.url;
  return typeof url === 'string' && url !== '' ? url : null;
}

/** An error answer addressed to the request's redirect URI (not a reflected parameter). */
function isErrorRedirect(url: string, redirectUri: string): boolean {
  if (!URL.canParse(url) || !URL.canParse(redirectUri)) return false;
  const answer = new URL(url);
  const target = new URL(redirectUri);
  return (
    answer.origin === target.origin &&
    answer.pathname === target.pathname &&
    answer.searchParams.has('error') &&
    !answer.searchParams.has('code')
  );
}

/** Discovery documents are public and read cross-origin by browser-based clients. */
function discoveryJson(c: Context<AppEnv>, document: unknown): Response {
  return c.json(document, 200, {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=3600',
  });
}

/**
 * RFC 8414 metadata: the provider's, minus what rooster does not offer (introspection, DPoP,
 * back-channel logout, JWKS, `client_credentials`), with `scopes_supported` and the code flow
 * pinned (PKCE S256 only, `iss` in responses). The device grant (Phase 12) is advertised only
 * when every CIMD client may use it (`ROOSTER_OAUTH_DEVICE=all`, 11 §9.1); `rooster-cli` knows
 * the endpoint.
 */
async function authorizationServerMetadata(deps: P9RouteDeps): Promise<Record<string, unknown>> {
  const provider = oauthProviderApi(deps.auth);
  const metadata = { ...((await provider.getOAuthServerConfig()) as Record<string, unknown>) };
  for (const key of Object.keys(metadata)) {
    if (/^(introspection_|dpop_|backchannel_|end_session_|userinfo_)/.test(key)) {
      delete metadata[key];
    }
  }
  delete metadata.jwks_uri;
  delete metadata.device_authorization_endpoint;
  if (!deps.config.oauthDcr) delete metadata.registration_endpoint;
  const device = deps.config.oauthDevice === 'all';
  return {
    ...metadata,
    ...(device
      ? { device_authorization_endpoint: `${oauthIssuer(deps.config)}${DEVICE_AUTHORIZATION_PATH}` }
      : {}),
    scopes_supported: [...OAUTH_SCOPES],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: [
      'authorization_code',
      'refresh_token',
      ...(device ? [DEVICE_CODE_GRANT_TYPE] : []),
    ],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  };
}

/**
 * One consent decision per user at a time: a decision stages its change around the provider's
 * answer, and an overlapping one must see the grant as the previous one left it.
 */
const consentLocks = new KeyedLock();

export function registerOAuthRoutes(app: OpenAPIHono<AppEnv>, deps: P9RouteDeps): void {
  const { config, services, logger } = deps;
  const provider = oauthProviderApi(deps.auth);
  for (const [name, schema] of [
    ['OAuthClientInfo', OAuthClientInfoSchema],
    ['OAuthConsentRequest', OAuthConsentRequestSchema],
    ['OAuthConsentDecision', OAuthConsentDecisionSchema],
    ['OAuthConsentResult', OAuthConsentResultSchema],
  ] as const) {
    app.openAPIRegistry.register(name, schema);
  }

  app.openapi(getConsent, async (c) => {
    const { oauth_query: oauthQuery } = c.req.valid('query');
    const query = await verifiedQuery(oauthQuery, config.authSecret);
    return c.json(services.grants.oauthConsentRequest(actorOf(c), oauthQuery, query), 200);
  });

  app.openapi(postConsent, async (c) => {
    const actor = actorOf(c);
    const decision = c.req.valid('json');
    const query = await verifiedQuery(decision.oauthQuery, config.authSecret);
    // The provider's consent endpoint reads the browser session from these headers; it may
    // change `accept`, so it gets a copy.
    const headers = () => new Headers(c.req.raw.headers);
    const request = () => new Request(c.req.url, { method: 'POST', headers: headers() });
    if (!decision.accept) {
      services.grants.checkOAuthDeny(actor, query, decision.oauthQuery, decision.decisionNonce);
      const url = await redirectUrl(
        await provider.oauth2Consent({
          headers: headers(),
          request: request(),
          body: { accept: false, oauth_query: decision.oauthQuery },
        }),
      );
      if (url === null) throw consentNotFound();
      return c.json({ redirectTo: url }, 200);
    }
    return consentLocks.run(actor.userId, async () => {
      const prepared = services.grants.applyOAuthConsent(actor, query, decision);
      // Every way out that does not commit (a refusal, an answer without a code, an exception
      // anywhere below) undoes the decision, provider consent included.
      let committed = false;
      try {
        let url: string | null = null;
        try {
          url = await redirectUrl(
            await consentHandoff.run(
              { userId: actor.userId, clientId: prepared.clientId, grantId: prepared.grantId },
              () =>
                provider.oauth2Consent({
                  headers: headers(),
                  request: request(),
                  body: {
                    accept: true,
                    ...(prepared.pluginScope === '' ? {} : { scope: prepared.pluginScope }),
                    oauth_query: decision.oauthQuery,
                  },
                }),
            ),
          );
        } catch (error) {
          logger.warn(
            { err: logSafeError(error) },
            'OAuth consent: the provider refused the decision',
          );
        }
        // Committed only for a genuine code (the service checks it is stored for this grant,
        // user, client and redirect URI, and that the grant did not change meanwhile).
        if (url !== null && services.grants.finishOAuthConsent(prepared, url)) {
          committed = true;
          return c.json({ redirectTo: url }, 200);
        }
        // The provider's own error redirect (e.g. `invalid_scope`) still goes to the app.
        if (url !== null && isErrorRedirect(url, prepared.redirectUri)) {
          return c.json({ redirectTo: url }, 200);
        }
        throw consentNotFound();
      } finally {
        if (!committed) services.grants.undoOAuthConsent(actor, prepared);
      }
    });
  });

  // RFC 9728 for the REST API (`mcp/route.ts` serves `/mcp`'s).
  app.get('/.well-known/oauth-protected-resource/api/v1', (c) =>
    discoveryJson(c, protectedResourceMetadata(config, 'api')),
  );
  // RFC 8414 with path insertion: the issuer is `<base>/api/auth` (ADR 0041).
  app.get('/.well-known/oauth-authorization-server/api/auth', async (c) =>
    discoveryJson(c, await authorizationServerMetadata(deps)),
  );
}
