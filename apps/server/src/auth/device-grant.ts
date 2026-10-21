import { createCimdClientDiscovery, isCimdClientIdUrlCandidate } from '@better-auth/cimd';
import {
  type ClientDiscovery,
  getOAuthProviderApi,
  type OAuthExtensionGrantHandler,
  type OAuthOptions,
  type OAuthProviderExtension,
  type SchemaClient,
  type Scope,
} from '@better-auth/oauth-provider';
import { ADMIN_SCOPE, ALL_GRANT_SCOPES, isGrantScope } from '@rooster/core/grants';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { redeemDeviceCode } from 'better-auth/plugins/device-authorization';
import { z } from 'zod';
import type { Config } from '../config.ts';
import {
  DEVICE_CODE_TTL_MS,
  DEVICE_POLL_INTERVAL_MAX_MS,
  DEVICE_POLL_INTERVAL_MS,
  DEVICE_SLOW_DOWN_MS,
  deviceGrantAllowed,
  formatUserCode,
  hashDeviceSecret,
} from '../services/device-codes.ts';
import { CLI_CLIENT_ID, DEVICE_CODE_GRANT_TYPE } from '../services/grant-service.ts';
import type { Services } from '../services/index.ts';
import { CIMD_DISCOVERY_ID } from '../services/oauth-grants.ts';
import { CLIENT_IP_HEADER } from './auth-paths.ts';
import { resourceOf } from './oauth-metadata.ts';

// Phase 12 (11 §9, ADR 0065): the OAuth device authorization grant (RFC 8628) on rooster's
// authorization server. better-auth's `oauthDeviceAuthorization` cannot be used as it is (it
// cannot coexist with the CLI's legacy `deviceAuthorization`, issues tokens without the grant
// as `referenceId`, and stores codes in the clear), so its parts are composed here:
// - `POST /api/auth/oauth2/device-authorization`: rooster's own endpoint (hashed codes, the
//   operator switch, one required `resource`, no `verification_uri_complete`);
// - the device grant type on `/api/auth/oauth2/token`, redeemed through the device plugin's
//   `redeemDeviceCode` state machine and issued through the provider with the grant id;
// - Client ID Metadata Documents without `redirect_uris`, for the device grant only.

/** The device authorization endpoint, relative to the auth base path. */
export const DEVICE_AUTHORIZATION_PATH = '/oauth2/device-authorization';

/** The longest `scope` a device authorization request may carry (11 §9.2). */
const DEVICE_SCOPE_MAX_BYTES = 512;
/** `authorization_details` are accepted (11 §9.2) but bounded like on the consent screen. */
const AUTHORIZATION_DETAILS_MAX = 8192;
/** A `client_id` longer than this is no CIMD URL rooster would fetch. */
const CLIENT_ID_MAX = 2048;
/** A third party's request without `scope` asks for the least (as the code flow does). */
const DEFAULT_APP_SCOPE = 'tasks:read';

/** Where a client without redirect URIs may be resolved: the device grant's endpoints. */
const DEVICE_ONLY_PATHS: ReadonlySet<string> = new Set([
  DEVICE_AUTHORIZATION_PATH,
  '/oauth2/token',
  '/oauth2/revoke',
]);

function oauthError(error: string, description: string): APIError {
  return new APIError('BAD_REQUEST', { error, error_description: description });
}

/** A provider `string[]` field: an array from the adapter, or JSON text from a raw row. */
function listOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value !== 'string' || value === '') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

type EndpointCtx = Parameters<ClientDiscovery['resolve']>[0];

/**
 * Client ID Metadata Documents (11 §4.2) with the rules of the MCP profile kept for every
 * client (a non-empty `client_name`), except that a client listing the device grant may omit
 * `redirect_uris` (CIMD draft-02 §4.2). Such a client resolves only on the device grant's
 * endpoints; anywhere else (authorize, consent) it is `invalid_client`. A device client always
 * gets refresh tokens (11 §9.2), whatever else its document lists.
 */
export function cimdDiscovery(
  fetchClientMetadataResource: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
): ClientDiscovery {
  const base = createCimdClientDiscovery({
    fetchClientMetadataResource,
    metadataRevalidationInterval: '24h',
  });
  return {
    ...base,
    resolve: async (ctx: EndpointCtx, clientId, existing) => {
      const client = await base.resolve(ctx, clientId, existing);
      return client === null ? null : deviceAware(ctx, client);
    },
  };
}

function deviceAware(ctx: EndpointCtx, client: SchemaClient<Scope[]>): SchemaClient<Scope[]> {
  if ((client.name ?? '').trim() === '') {
    throw oauthError('invalid_client', 'client_name must be a non-empty string');
  }
  const grantTypes = listOf(client.grantTypes);
  const device = grantTypes.includes(DEVICE_CODE_GRANT_TYPE);
  if (listOf(client.redirectUris).length === 0) {
    if (!device) {
      throw oauthError(
        'invalid_client',
        'redirect_uris must be a non-empty array of absolute HTTP(S) or private-use URIs',
      );
    }
    if (!DEVICE_ONLY_PATHS.has(ctx.path ?? '')) {
      throw oauthError('invalid_client', 'This client has no redirect URIs: use the device grant.');
    }
  }
  if (!device) return client;
  const scopes = listOf(client.scopes);
  return {
    ...client,
    grantTypes: [...new Set([...grantTypes, 'refresh_token'])] as NonNullable<
      SchemaClient<Scope[]>['grantTypes']
    >,
    ...(scopes.length === 0 ? {} : { scopes: [...new Set([...scopes, 'offline_access'])] }),
  };
}

function providerOptions(ctx: EndpointCtx): OAuthOptions<Scope[]> {
  const provider = ctx.context.getPlugin('oauth-provider') as { options: OAuthOptions<Scope[]> };
  return provider.options;
}

/** The record `redeemDeviceCode` hands the grant: the plugin's fields plus rooster's. */
interface DeviceRecord {
  id: string;
  status: string;
  userId?: string | null;
  lastPolledAt?: Date | string | null;
  pollingInterval?: number | null;
  oauthClientId?: string | null;
  resource?: string | null;
  grantId?: string | null;
}

/**
 * RFC 8628 §3.5: a poll sooner than the interval is `slow_down`, and the interval grows by
 * 5 seconds for the rest of the code's life (better-auth only refuses the poll).
 */
async function slowDown(ctx: EndpointCtx, record: DeviceRecord): Promise<void> {
  const interval = record.pollingInterval ?? DEVICE_POLL_INTERVAL_MS;
  if (record.lastPolledAt === null || record.lastPolledAt === undefined) return;
  if (Date.now() - new Date(record.lastPolledAt).getTime() >= interval) return;
  await ctx.context.adapter.update({
    model: 'deviceCode',
    where: [{ field: 'id', value: record.id }],
    update: {
      pollingInterval: Math.min(interval + DEVICE_SLOW_DOWN_MS, DEVICE_POLL_INTERVAL_MAX_MS),
    },
  });
  throw oauthError('slow_down', 'Polling too fast; wait at least 5 seconds longer each time.');
}

export interface DeviceGrantDeps {
  config: Config;
  services: Services;
  cimdFetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** The polling interval a new device code starts with (`DEVICE_POLL_INTERVAL_MS`). */
  intervalMs: number;
}

/**
 * The provider extension: CIMD clients (device-aware) and the device grant at the token
 * endpoint. Redemption is the device plugin's state machine (pending, slow down, denied,
 * expired, one atomic claim of an approved code), on the hash of the presented code; the code
 * must belong to the authenticated client, name the same `resource`, and carry a live grant.
 * Tokens are issued with that grant as `referenceId`, bound to the one resource.
 */
export function deviceGrantExtension(deps: DeviceGrantDeps): OAuthProviderExtension {
  const { config, services } = deps;
  const exchange: OAuthExtensionGrantHandler = async ({ ctx, provider }) => {
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const plain = body.device_code;
    if (typeof plain !== 'string' || plain === '') {
      throw oauthError('invalid_request', 'device_code is required.');
    }
    const clientId = typeof body.client_id === 'string' ? body.client_id : undefined;
    const resource = typeof body.resource === 'string' ? body.resource : undefined;
    const { authorizationContext, redemptionContext, user } = await redeemDeviceCode<
      Record<string, unknown>,
      Awaited<ReturnType<typeof provider.authenticateClient>>,
      { grantId: string; resource: string }
    >({
      ctx,
      deviceCode: hashDeviceSecret(plain),
      authorizeRedemption: async (raw) => {
        const record = raw as unknown as DeviceRecord;
        // A legacy CLI code redeems at `/api/auth/device/token` for a session, never here.
        const owner = record.oauthClientId;
        if (typeof owner !== 'string' || clientId !== owner) {
          throw oauthError('invalid_grant', 'Unknown device code.');
        }
        if (!deviceGrantAllowed(config.oauthDevice, owner)) {
          throw oauthError('unauthorized_client', 'This client may not use the device grant.');
        }
        const authentication = await provider.authenticateClient({ requireCredentials: false });
        if (authentication.clientId !== owner) {
          throw oauthError('invalid_grant', 'Unknown device code.');
        }
        if (resource === undefined || resource !== record.resource) {
          throw oauthError('invalid_target', 'Send the resource the device code was issued for.');
        }
        await slowDown(ctx, record);
        return {
          ownershipWhere: { field: 'oauthClientId', value: owner },
          context: authentication,
        };
      },
      prepareRedemption: (raw) => {
        const record = raw as unknown as DeviceRecord;
        const grantId = services.grants.deviceCodeGrant(record);
        if (grantId === null) {
          throw oauthError('invalid_grant', 'The approval was revoked; start again.');
        }
        return { grantId, resource: record.resource as string };
      },
    });
    const client = authorizationContext.client;
    // The stored scopes are informational (the grant is read on every request) but must stay
    // within what the client is registered for, or its refresh would be refused.
    const allowed = listOf(client.scopes);
    const scopes = (services.grants.oauthTokenScope(redemptionContext.grantId, true) ?? '')
      .split(' ')
      .filter(
        (s) => s !== '' && s !== ADMIN_SCOPE && (allowed.length === 0 || allowed.includes(s)),
      );
    return provider.issueTokens({
      client,
      scopes: scopes.includes('offline_access') ? scopes : [...scopes, 'offline_access'],
      user,
      resources: [redemptionContext.resource],
      referenceId: redemptionContext.grantId,
    });
  };
  return {
    grants: { [DEVICE_CODE_GRANT_TYPE]: exchange },
    clientDiscovery: cimdDiscovery(deps.cimdFetch),
  };
}

const deviceAuthorizationBody = z
  .object({
    client_id: z.string().optional(),
    scope: z.string().optional(),
    resource: z.string().optional(),
    authorization_details: z.string().optional(),
  })
  .passthrough();

/**
 * `POST /api/auth/oauth2/device-authorization` (RFC 8628 §3.1, 11 §9.2). The mount makes the
 * fields canonical and applies the rate limits first. Checks, in order: the operator's switch
 * (before any metadata fetch), the client kind (`rooster-cli` or a CIMD URL; DCR clients never),
 * exactly one known `resource`, the scopes, then the client itself (its document fetched and
 * validated, the device grant among its grant types, client authentication if it has any).
 */
export function deviceGrantPlugin(deps: DeviceGrantDeps): BetterAuthPlugin {
  const { config, services } = deps;
  return {
    id: 'rooster-device-grant',
    endpoints: {
      roosterDeviceAuthorization: createAuthEndpoint(
        DEVICE_AUTHORIZATION_PATH,
        {
          method: 'POST',
          cloneRequest: true,
          body: deviceAuthorizationBody,
          metadata: { allowedMediaTypes: ['application/x-www-form-urlencoded'] },
          onValidationError: () => {
            throw oauthError('invalid_request', 'Send each parameter once, as a string.');
          },
        },
        async (ctx) => {
          const body = ctx.body;
          const clientId = body.client_id ?? '';
          if (clientId === '') throw oauthError('invalid_request', 'client_id is required.');
          if (clientId.length > CLIENT_ID_MAX)
            throw oauthError('invalid_client', 'Unknown client.');
          if (!deviceGrantAllowed(config.oauthDevice, clientId)) {
            throw oauthError(
              'unauthorized_client',
              'This client may not use the device grant on this server.',
            );
          }
          const firstParty = clientId === CLI_CLIENT_ID;
          if (!firstParty && !isCimdClientIdUrlCandidate(clientId)) {
            throw oauthError(
              'unauthorized_client',
              'Only clients with a Client ID Metadata Document may use the device grant.',
            );
          }
          const resource = body.resource;
          if (resource === undefined || resourceOf(config, resource) === null) {
            throw oauthError(
              'invalid_target',
              `Send exactly one resource: ${config.baseUrl}/mcp or ${config.baseUrl}/api/v1.`,
            );
          }
          const raw = body.scope ?? '';
          if (Buffer.byteLength(raw) > DEVICE_SCOPE_MAX_BYTES) {
            throw oauthError('invalid_scope', 'The scope is too long.');
          }
          // `offline_access` is implied: a device client always gets a refresh token.
          const words = raw.split(/\s+/).filter((s) => s !== '' && s !== 'offline_access');
          if (words.some((s) => !isGrantScope(s))) {
            throw oauthError('invalid_scope', 'Unknown scope requested.');
          }
          if (!firstParty && words.includes(ADMIN_SCOPE)) {
            throw oauthError('invalid_scope', 'Apps cannot ask for the admin permission.');
          }
          // Stored canonical: known scopes, once each, in contract order. `rooster-cli` without
          // a scope asks for everything (approval drops `admin` for non-admins, ADR 0042 §1).
          const canonical = ALL_GRANT_SCOPES.filter((s) => words.includes(s));
          if (!firstParty && canonical.length === 0) canonical.push(DEFAULT_APP_SCOPE);
          if ((body.authorization_details?.length ?? 0) > AUTHORIZATION_DETAILS_MAX) {
            throw oauthError('invalid_request', 'authorization_details is too long.');
          }
          const provider = getOAuthProviderApi(ctx, providerOptions(ctx), DEVICE_CODE_GRANT_TYPE);
          const authenticated = await provider.authenticateClient({
            requireCredentials: false,
            ...(firstParty ? {} : { scopes: canonical }),
          });
          if (authenticated.clientId !== clientId) {
            throw oauthError('invalid_client', 'Client ID mismatch.');
          }
          if (!firstParty && authenticated.client.clientDiscoveryId !== CIMD_DISCOVERY_ID) {
            throw oauthError(
              'unauthorized_client',
              'Only clients with a Client ID Metadata Document may use the device grant.',
            );
          }
          const headers = ctx.request?.headers;
          const codes = services.grants.createDeviceRequest({
            clientId,
            scope: canonical.length === 0 ? undefined : canonical.join(' '),
            resource,
            requestIp: headers?.get(CLIENT_IP_HEADER) ?? null,
            userAgent: headers?.get('user-agent')?.slice(0, 200) ?? null,
            pollingIntervalMs: deps.intervalMs,
          });
          ctx.setHeader('Cache-Control', 'no-store');
          ctx.setHeader('Pragma', 'no-cache');
          // No `verification_uri_complete`: the user always types the code (11 §9.2).
          return ctx.json({
            device_code: codes.deviceCode,
            user_code: formatUserCode(codes.userCode),
            verification_uri: `${config.baseUrl}/device`,
            expires_in: DEVICE_CODE_TTL_MS / 1000,
            interval: Math.ceil(deps.intervalMs / 1000),
          });
        },
      ),
    },
  } as unknown as BetterAuthPlugin;
}
