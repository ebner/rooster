// Shared helpers for the remote MCP endpoint tests (WP 9.4).

import { defaultKeyHasher } from '@better-auth/api-key';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { GrantConstraints, GrantScope } from '@rooster/core/grants';
import type { TokenCreated } from '@rooster/core/schemas';
import type { App } from '../src/app.ts';
import type { OAuthResource } from '../src/auth/oauth-bearer.ts';
import type { Actor } from '../src/services/index.ts';
import { pat } from './grant-helpers.ts';
import { BASE_URL } from './helpers.ts';
import type { Caller } from './list-helpers.ts';

export const MCP_URL = `${BASE_URL}/mcp`;
export const RESOURCE_METADATA_URL = `${BASE_URL}/.well-known/oauth-protected-resource/mcp`;

type Resolver = (
  token: string,
  resource: OAuthResource,
  ip: string | null,
) => Promise<Actor | null>;

/**
 * The seam until the OAuth provider lands: `GrantService.resolveOAuthToken` (what
 * `resolveOAuthBearer` calls) is replaced by a resolver over PATs. Each fake token is bound to
 * one resource and resolves through the PAT's live grant, so revocation, expiry and constraint
 * edits behave as for a real token. The actor is shaped like an OAuth one (`via: 'oauth'`,
 * grant kind `oauth`).
 */
export class FakeOAuth {
  private readonly tokens = new Map<string, { pat: string; resource: OAuthResource }>();
  private seq = 0;
  readonly calls: { token: string; resource: OAuthResource }[] = [];

  constructor(private readonly app: App) {
    const resolve: Resolver = async (token, resource, ip) => {
      this.calls.push({ token, resource });
      const entry = this.tokens.get(token);
      if (entry === undefined || entry.resource !== resource) return null;
      const actor = this.app.services.grants.resolvePat(await defaultKeyHasher(entry.pat), ip);
      if (actor?.grant == null) return null;
      return { ...actor, via: 'oauth', grant: { ...actor.grant, kind: 'oauth', resource } };
    };
    (app.services.grants as unknown as { resolveOAuthToken: Resolver }).resolveOAuthToken = resolve;
  }

  /** A token for `resource`, backed by a new PAT of `owner` with these scopes and constraints. */
  async token(
    owner: Caller,
    scopes: GrantScope[],
    constraints: GrantConstraints = { orgs: 'all' },
    resource: OAuthResource = 'mcp',
  ): Promise<{ token: string; created: TokenCreated }> {
    const created = await pat(owner, scopes, constraints);
    this.seq += 1;
    const token = `rooster_at_fake${this.seq}`;
    this.tokens.set(token, { pat: created.token, resource });
    return { token, created };
  }
}

/**
 * The parameters of a `WWW-Authenticate: Bearer …` header (RFC 6750 §3), or null for another
 * scheme or none. Every rooster value is a quoted string without escapes.
 */
export function challenge(res: Response): Record<string, string> | null {
  const header = res.headers.get('www-authenticate');
  if (header === null || !header.startsWith('Bearer ')) return null;
  const params: Record<string, string> = {};
  for (const match of header.slice(7).matchAll(/([a-z_]+)="([^"]*)"/g)) {
    params[match[1] as string] = match[2] as string;
  }
  return params;
}

/** `fetch` for the MCP SDK client: straight into the app, no network. */
export function appFetch(app: App) {
  return (url: string | URL, init?: RequestInit) =>
    Promise.resolve(app.fetch(new Request(url, init)));
}

/** A raw JSON-RPC POST to `/mcp`. */
export async function rpc(
  app: App,
  token: string | null,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** A connected MCP SDK client (default protocol negotiation) against the app. */
export async function mcpClient(app: App, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    fetch: appFetch(app),
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'rooster-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}
