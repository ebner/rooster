import type { Actor } from '../services/context.ts';

/** The two protected resources (11 §4.3); a token is accepted only by the one it was issued for. */
export type OAuthResource = 'mcp' | 'api';

/**
 * P9 WP 9.3 (owned by the OAuth agent): resolves an OAuth access token for `resource` to its
 * actor (`via: 'oauth'`, the grant attached), or null when it is unknown, expired, revoked,
 * idle-expired or issued for the other resource. The remote MCP endpoint calls it for every
 * request; the actor middleware calls it with `'api'`.
 */
export async function resolveOAuthBearer(
  _token: string,
  _resource: OAuthResource,
  _ip: string | null,
): Promise<Actor | null> {
  return null;
}
