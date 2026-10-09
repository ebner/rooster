import type { Config } from '../config.ts';
import { AUTH_BASE_PATH } from './auth-paths.ts';
import type { OAuthResource } from './oauth-bearer.ts';

/**
 * OAuth discovery helpers (11 §4, §5.2, ADR 0041). The remote MCP endpoint uses
 * `protectedResourceMetadata(config, 'mcp')` and `wwwAuthenticate(config, 'mcp', …)`; the REST
 * API uses them with `'api'`.
 */

/** The authorization server's issuer: `<base>/api/auth` (RFC 8414 path insertion). */
export function oauthIssuer(config: Config): string {
  return `${config.baseUrl}${AUTH_BASE_PATH}`;
}

/** The canonical URI of a protected resource (RFC 8707 `resource`, RFC 9728 `resource`). */
export function resourceUri(config: Config, resource: OAuthResource): string {
  return resource === 'mcp' ? `${config.baseUrl}/mcp` : `${config.baseUrl}/api/v1`;
}

/** The resource a canonical URI names, or null. */
export function resourceOf(config: Config, uri: string): OAuthResource | null {
  if (uri === resourceUri(config, 'mcp')) return 'mcp';
  if (uri === resourceUri(config, 'api')) return 'api';
  return null;
}

/** Where the RFC 9728 document of a resource is served: `/.well-known/oauth-protected-resource/…`. */
export function protectedResourceMetadataUrl(config: Config, resource: OAuthResource): string {
  const path = resource === 'mcp' ? '/mcp' : '/api/v1';
  return `${config.baseUrl}/.well-known/oauth-protected-resource${path}`;
}

/**
 * The scopes a protected resource advertises: the minimum, as MCP asks (clients step up through
 * `insufficient_scope` challenges).
 */
export const ADVERTISED_RESOURCE_SCOPES = ['tasks:read'] as const;

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
  resource_name: string;
}

/** RFC 9728 protected resource metadata for `/mcp` or `/api/v1`. */
export function protectedResourceMetadata(
  config: Config,
  resource: OAuthResource,
): ProtectedResourceMetadata {
  return {
    resource: resourceUri(config, resource),
    authorization_servers: [oauthIssuer(config)],
    scopes_supported: [...ADVERTISED_RESOURCE_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'rooster',
  };
}

/** Quoted-string content (RFC 9110 §5.6.4): no quotes, backslashes or control characters. */
function quoted(value: string): string {
  const printable = [...value]
    .filter((ch) => ch !== '"' && ch !== '\\' && ch >= ' ' && ch !== '\u007f')
    .join('');
  return `"${printable}"`;
}

/**
 * The `WWW-Authenticate` value of a `401` or `403` from a protected resource (RFC 6750 §3,
 * RFC 9728 §5.1, MCP scope challenges):
 * - no `error` for a request without a token (`401`);
 * - `invalid_token` for an unknown, expired, revoked or wrong-audience token (`401`);
 * - `insufficient_scope` with every scope the call needs (`403`).
 */
export function wwwAuthenticate(
  config: Config,
  resource: OAuthResource,
  options: {
    error?: 'invalid_token' | 'insufficient_scope' | 'invalid_request';
    scope: string | readonly string[];
    description?: string;
  },
): string {
  const scope = typeof options.scope === 'string' ? options.scope : options.scope.join(' ');
  const parts = [
    ...(options.error === undefined ? [] : [`error=${quoted(options.error)}`]),
    ...(options.description === undefined
      ? []
      : [`error_description=${quoted(options.description)}`]),
    `scope=${quoted(scope)}`,
    `resource_metadata=${quoted(protectedResourceMetadataUrl(config, resource))}`,
  ];
  return `Bearer ${parts.join(', ')}`;
}
