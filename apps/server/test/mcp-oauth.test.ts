// AC-9.3 / AC-9.4 at the server level with the real OAuth provider: an MCP client that knows
// only `<base>/mcp` discovers the authorization server (RFC 9728 → RFC 8414), registers through a
// Client ID Metadata Document, runs PKCE with `resource` and `iss`, the user consents, and the
// client calls tools with the token. The browser leg (redirects, the consent page) is driven
// directly against the provider and the consent API; the e2e suite covers the real browser.
import { createHash, randomBytes } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/client';
import type { GrantConstraints, GrantScope } from '@rooster/core/grants';
import type { Grant, OAuthConsentRequest } from '@rooster/core/schemas';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { createLogger } from '../src/lib/logger.ts';
import { FakePush } from './delivery-fakes.ts';
import { asJar, BASE_URL, createTestDb, createUserWithSession, testConfig } from './helpers.ts';
import { challenge, MCP_URL, mcpClient, rpc } from './mcp-helpers.ts';

const CLIENT_ID = 'https://agent.example/oauth/client.json';
const REDIRECT_URI = 'http://127.0.0.1:33418/callback';
const CLIENT_METADATA = {
  client_id: CLIENT_ID,
  client_name: 'Test Agent',
  client_uri: 'https://agent.example',
  redirect_uris: [REDIRECT_URI],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
};

function setup() {
  const config = testConfig({ ROOSTER_WEB_DIR: '/nonexistent/web' });
  const db = createTestDb();
  const cimdFetched: string[] = [];
  const app = createApp({
    config,
    db,
    logger: createLogger('silent'),
    version: '0.0.0-test',
    authRateLimit: false,
    apiRateLimit: false,
    transports: { pushSender: new FakePush().sender, mailTransport: null },
    // The client's metadata document, as the CIMD guard would fetch it from the internet.
    cimdFetch: async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      cimdFetched.push(url);
      return url === CLIENT_ID
        ? Response.json(CLIENT_METADATA, { headers: { 'cache-control': 'max-age=300' } })
        : new Response('not found', { status: 404 });
    },
  });
  const user = createUserWithSession(app, db, { email: 'alice@example.com', name: 'Alice' });
  const call = (path: string, init: RequestInit = {}) => app.request(path, asJar(user.jar, init));
  return { app, user, call, cimdFetched };
}

type Ctx = ReturnType<typeof setup>;

const local = (url: string) => (url.startsWith(BASE_URL) ? url.slice(BASE_URL.length) : url);

/** Client side of discovery, from nothing but the MCP URL (MCP authorization, RFC 9728/8414). */
async function discover(app: Ctx['app']) {
  const unauthorized = await rpc(app, null, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'list_tasks', arguments: {} },
  });
  expect(unauthorized.status).toBe(401);
  const params = challenge(unauthorized);
  expect(params?.scope).toBe('tasks:read');
  const prm = (await (await app.request(local(params?.resource_metadata ?? ''))).json()) as {
    resource: string;
    authorization_servers: string[];
  };
  expect(prm.resource).toBe(MCP_URL);
  const issuer = prm.authorization_servers[0] ?? '';
  // RFC 8414 §3.1: the well-known suffix goes between the host and the issuer's path.
  const issuerUrl = new URL(issuer);
  const asMetadataPath = `/.well-known/oauth-authorization-server${issuerUrl.pathname}`;
  const asRes = await app.request(asMetadataPath);
  expect(asRes.status).toBe(200);
  const as = (await asRes.json()) as {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    code_challenge_methods_supported: string[];
    client_id_metadata_document_supported: boolean;
    authorization_response_iss_parameter_supported: boolean;
  };
  expect(as.issuer).toBe(issuer);
  expect(as.code_challenge_methods_supported).toEqual(['S256']);
  expect(as.client_id_metadata_document_supported).toBe(true);
  expect(as.authorization_response_iss_parameter_supported).toBe(true);
  return { resource: prm.resource, issuer, as };
}

interface Consent {
  scopes: GrantScope[];
  constraints: GrantConstraints;
}

/**
 * Authorization code + PKCE for `resource`, the user consenting with `consent`; returns the
 * access token. Every step is checked as a client implementing the 2026-07-28 auth spec would.
 */
async function authorize(
  ctx: Ctx,
  options: { scope: string; resource: string; consent: Consent },
): Promise<{ accessToken: string; refreshToken: string | undefined; scope: string }> {
  const { as, issuer } = await discover(ctx.app);
  const verifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(8).toString('hex');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: options.scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    resource: options.resource,
  });
  const auth = await ctx.call(`${local(as.authorization_endpoint)}?${query}`);
  expect(auth.status, await auth.clone().text()).toBeGreaterThanOrEqual(300);
  expect(auth.status).toBeLessThan(400);
  const consentPage = new URL(auth.headers.get('location') ?? '', BASE_URL);
  expect(consentPage.pathname).toBe('/oauth/consent');
  const oauthQuery = consentPage.search.slice(1);

  const requestRes = await ctx.call(
    `/api/v1/oauth/consent?${new URLSearchParams({ oauth_query: oauthQuery })}`,
  );
  expect(requestRes.status, await requestRes.clone().text()).toBe(200);
  const request = (await requestRes.json()) as OAuthConsentRequest;
  expect(request.clientId).toBe(CLIENT_ID);
  expect(request.resource).toBe(options.resource);
  expect(request.redirectUri).toBe(REDIRECT_URI);

  const decision = await ctx.call('/api/v1/oauth/consent', {
    method: 'POST',
    body: JSON.stringify({
      accept: true,
      oauthQuery: request.oauthQuery,
      decisionNonce: request.decisionNonce,
      ...options.consent,
    }),
  });
  expect(decision.status, await decision.clone().text()).toBe(200);
  const { redirectTo } = (await decision.json()) as { redirectTo: string };
  const back = new URL(redirectTo);
  expect(`${back.origin}${back.pathname}`).toBe(REDIRECT_URI);
  expect(back.searchParams.get('state')).toBe(state);
  // RFC 9207: the client checks `iss` before using the code.
  expect(back.searchParams.get('iss')).toBe(issuer);
  const code = back.searchParams.get('code');
  expect(code).toBeTruthy();

  const tokenRes = await ctx.app.request(local(as.token_endpoint), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code ?? '',
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: verifier,
      resource: options.resource,
    }),
  });
  expect(tokenRes.status, await tokenRes.clone().text()).toBe(200);
  const token = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    token_type: string;
    scope: string;
  };
  expect(token.token_type.toLowerCase()).toBe('bearer');
  return { accessToken: token.access_token, refreshToken: token.refresh_token, scope: token.scope };
}

function text(result: CallToolResult): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

async function personalOrg(ctx: Ctx): Promise<string> {
  const me = (await (await ctx.call('/api/v1/me')).json()) as {
    orgs: { id: string; isPersonal: boolean }[];
  };
  const id = me.orgs.find((o) => o.isPersonal)?.id;
  if (id === undefined) throw new Error('no personal org');
  return id;
}

async function myGrants(ctx: Ctx): Promise<Grant[]> {
  return (await (await ctx.call('/api/v1/me/grants')).json()) as Grant[];
}

describe('AC-9.3 an MCP client from the bare /mcp URL to a tool call (real OAuth)', () => {
  it('discovers, registers by CIMD, runs PKCE with resource and iss, and lists one org', async () => {
    const ctx = setup();
    const orgId = await personalOrg(ctx);
    await ctx.call(`/api/v1/orgs/${orgId}/tasks`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Water the plants' }),
    });
    const { accessToken } = await authorize(ctx, {
      scope: 'tasks:read',
      resource: MCP_URL,
      consent: {
        scopes: ['tasks:read'],
        constraints: { orgs: [{ orgId, read: 'all', write: 'none' }] },
      },
    });
    expect(ctx.cimdFetched).toContain(CLIENT_ID);

    const client = await mcpClient(ctx.app, accessToken);
    const result = (await client.callTool({ name: 'list_tasks', arguments: {} })) as CallToolResult;
    expect(result.isError, text(result)).toBeFalsy();
    expect(text(result)).toContain('Water the plants');
  });

  it('binds tokens to their resource: an /mcp token fails on /api/v1 and vice versa', async () => {
    const ctx = setup();
    const consent: Consent = { scopes: ['tasks:read'], constraints: { orgs: 'all' } };
    const mcp = await authorize(ctx, { scope: 'tasks:read', resource: MCP_URL, consent });
    const api = await authorize(ctx, {
      scope: 'tasks:read',
      resource: `${BASE_URL}/api/v1`,
      consent,
    });
    const restWith = (token: string) =>
      ctx.app.request('/api/v1/me', { headers: { authorization: `Bearer ${token}` } });
    expect((await restWith(mcp.accessToken)).status).toBe(401);
    expect((await restWith(api.accessToken)).status).toBe(200);
    const onMcp = await rpc(ctx.app, api.accessToken, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    expect(onMcp.status).toBe(401);
    expect(challenge(onMcp)?.error).toBe('invalid_token');
    expect(
      (await rpc(ctx.app, mcp.accessToken, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status,
    ).toBe(200);
  });
});

describe('AC-9.4 step-up, write constraints and revocation (real OAuth)', () => {
  it('challenges, steps up to writing in the Inbox only, and stops after revocation', async () => {
    const ctx = setup();
    const orgId = await personalOrg(ctx);
    const { groups } = (await (await ctx.call(`/api/v1/orgs/${orgId}/my-list`)).json()) as {
      groups: { id: string; name: string; kind: string }[];
    };
    const inbox = groups.find((g) => g.kind === 'inbox');
    if (inbox === undefined) throw new Error('inbox');

    const read = await authorize(ctx, {
      scope: 'tasks:read',
      resource: MCP_URL,
      consent: { scopes: ['tasks:read'], constraints: { orgs: 'all' } },
    });
    const denied = await rpc(ctx.app, read.accessToken, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'create_task', arguments: { title: 'Plan trip' } },
    });
    expect(denied.status).toBe(403);
    expect(challenge(denied)).toMatchObject({ error: 'insufficient_scope', scope: 'tasks:write' });

    // Step-up: the client asks again with the challenged scope; the user allows the Inbox only.
    const write = await authorize(ctx, {
      scope: 'tasks:write',
      resource: MCP_URL,
      consent: {
        scopes: ['tasks:write'],
        constraints: { orgs: [{ orgId, read: 'all', write: { groups: [inbox.id] } }] },
      },
    });
    const client = await mcpClient(ctx.app, write.accessToken);
    const created = (await client.callTool({
      name: 'create_task',
      arguments: { title: 'Plan trip' },
    })) as CallToolResult;
    expect(created.isError, text(created)).toBeFalsy();
    const list = (await (await ctx.call(`/api/v1/orgs/${orgId}/my-list`)).json()) as {
      tasks: { id: string; title: string; seq: number | null }[];
    };
    const task = list.tasks.find((t) => t.title === 'Plan trip');
    if (task === undefined) throw new Error('task');
    const moved = (await client.callTool({
      name: 'move_task',
      arguments: { ref: String(task.seq), group: 'Prio' },
    })) as CallToolResult;
    expect(moved.isError).toBe(true);
    expect(text(moved)).toContain('outside_grant');
    expect(text(moved)).toContain(inbox.name);

    const feed = (await (await ctx.call(`/api/v1/tasks/${task.id}/activity`)).json()) as {
      items: { activity?: { type: string; via: string } }[];
    };
    expect(feed.items.flatMap((i) => (i.activity ? [i.activity.via] : []))).toEqual(['mcp']);

    // Settings → Connected apps: revoke the app's grant; the next call is 401.
    const grant = (await myGrants(ctx)).find((g) => g.kind === 'oauth');
    if (grant === undefined) throw new Error('grant');
    expect((await ctx.call(`/api/v1/me/grants/${grant.id}`, { method: 'DELETE' })).status).toBe(
      204,
    );
    const after = await rpc(ctx.app, write.accessToken, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'list_tasks', arguments: {} },
    });
    expect(after.status).toBe(401);
    expect(challenge(after)?.error).toBe('invalid_token');
  });
});
