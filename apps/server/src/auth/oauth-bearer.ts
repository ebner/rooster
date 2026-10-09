import type { Actor, Services } from '../services/index.ts';

/** The two protected resources (11 §4.3); a token is accepted only by the one it was issued for. */
export type OAuthResource = 'mcp' | 'api';

/**
 * Resolves an OAuth access token (`Authorization: Bearer rooster_at_…`) for `resource` to its
 * actor, or null when the token is unknown, expired, revoked, idle-expired, issued for the other
 * resource, or its grant or user is no longer live (answer `401` with `wwwAuthenticate`).
 *
 * Signature (P9, final): `resolveOAuthBearer(services, token, resource, ip)`.
 * - `services`: the app's `Services` (`P9RouteDeps.services`).
 * - `token`: the raw bearer value, without `Bearer `.
 * - `resource`: `'mcp'` on `/mcp`, `'api'` on `/api/v1` (the actor middleware).
 * - `ip`: the client IP (`clientIp(c, config)`), recorded as the grant's `last_used_ip`.
 *
 * The actor has `via: 'oauth'` and `grant` set from the rooster grant (scopes and constraints
 * are the grant's, never the token's scope string), with `grant.resource` naming the resource
 * the token is bound to: activity records `via: 'mcp'` for `'mcp'` and `'oauth'` for `'api'`.
 * Pass the actor unchanged to `app.fetch(request, { [IN_PROCESS_ACTOR]: actor })`.
 */
export function resolveOAuthBearer(
  services: Services,
  token: string,
  resource: OAuthResource,
  ip: string | null,
): Promise<Actor | null> {
  return Promise.resolve(services.grants.resolveOAuthToken(token, resource, ip));
}
