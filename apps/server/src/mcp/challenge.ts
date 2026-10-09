import type { GrantScope } from '@rooster/core/grants';
import {
  type ProtectedResourceMetadata,
  protectedResourceMetadata,
  wwwAuthenticate,
} from '../auth/oauth-metadata.ts';
import type { Config } from '../config.ts';

/**
 * The OAuth pieces the remote MCP endpoint answers with (11 §5.2), over the shared helpers in
 * `auth/oauth-metadata.ts`: the RFC 9728 protected resource metadata and the RFC 6750
 * `WWW-Authenticate` challenges, both for the `mcp` resource.
 */

/** The MCP endpoint, relative to `ROOSTER_BASE_URL` (the canonical resource URI, 11 §4.3). */
export const MCP_PATH = '/mcp';
/** RFC 9728 §3.1: the well-known suffix inserted before the resource's path. */
export const PROTECTED_RESOURCE_WELL_KNOWN = '/.well-known/oauth-protected-resource';
export const MCP_RESOURCE_METADATA_PATH = `${PROTECTED_RESOURCE_WELL_KNOWN}${MCP_PATH}`;

/** What `scopes_supported` and the 401 challenge advertise: the minimum, then step up (MCP). */
export const MCP_BASE_SCOPE: GrantScope = 'tasks:read';

/** RFC 9728 §2 metadata for `/mcp`. Reveals only that the endpoint exists. */
export function mcpProtectedResourceMetadata(config: Config): ProtectedResourceMetadata {
  return protectedResourceMetadata(config, 'mcp');
}

/** `WWW-Authenticate: Bearer …` for `/mcp`: `error` when there is one, `scope`, `resource_metadata`. */
export function mcpChallenge(
  config: Config,
  options: { error?: 'invalid_token' | 'insufficient_scope'; scope: readonly GrantScope[] },
): string {
  return wwwAuthenticate(config, 'mcp', options);
}
