// Shared helpers for the OAuth tests (WP 9.3): a CIMD client served by a fake transport, PKCE,
// and the authorization code flow through the provider, the consent API and the token endpoint.
import { createHash, randomBytes } from 'node:crypto';
import type { GrantConstraints, GrantScope } from '@rooster/core/grants';
import type { OAuthConsentRequest } from '@rooster/core/schemas';
import { eq } from 'drizzle-orm';
import { expect } from 'vitest';
import { accessGrant, oauthAccessToken, oauthRefreshToken } from '../src/db/schema/index.ts';
import { BASE_URL } from './helpers.ts';
import { type Caller, type ListCtx, listCtx } from './list-helpers.ts';

export const CLIENT_ID = 'https://app.example.com/oauth/client.json';
export const REDIRECT_URI = 'https://app.example.com/callback';
export const MCP_RESOURCE = `${BASE_URL}/mcp`;
export const API_RESOURCE = `${BASE_URL}/api/v1`;
export const ISSUER = `${BASE_URL}/api/auth`;

export interface MetadataDoc {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  [key: string]: unknown;
}

export function metadataDoc(clientId = CLIENT_ID, extra: Partial<MetadataDoc> = {}): MetadataDoc {
  const origin = new URL(clientId).origin;
  return {
    client_id: clientId,
    client_name: 'Example App',
    client_uri: origin,
    redirect_uris: [`${origin}/callback`],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    ...extra,
  };
}

/** A CIMD transport serving JSON documents by URL (anything else is a 404). */
export function fakeCimd(docs: Record<string, unknown> = { [CLIENT_ID]: metadataDoc() }) {
  const fetched: string[] = [];
  const fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    fetched.push(url);
    const doc = docs[url];
    if (doc === undefined) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(doc), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch, fetched, docs };
}

export interface OAuthCtx extends ListCtx {
  cimd: ReturnType<typeof fakeCimd>;
}

export function oauthCtx(
  options: {
    clock?: () => number;
    env?: Record<string, string>;
    cimd?: ReturnType<typeof fakeCimd>;
  } = {},
): OAuthCtx {
  const cimd = options.cimd ?? fakeCimd();
  const ctx = listCtx({
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.env === undefined ? {} : { env: options.env }),
    cimdFetch: cimd.fetch,
  });
  return { ...ctx, cimd };
}

export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export interface AuthorizeParams {
  clientId?: string;
  redirectUri?: string;
  scope?: string | null;
  resource?: string | string[] | null;
  state?: string;
  challenge?: string | null;
  method?: string;
  extra?: Record<string, string>;
}

export function authorizeUrl(params: AuthorizeParams, challenge: string): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: params.clientId ?? CLIENT_ID,
    redirect_uri: params.redirectUri ?? REDIRECT_URI,
    state: params.state ?? 'xyz',
  });
  if (params.scope !== null) q.set('scope', params.scope ?? 'tasks:read offline_access');
  const resources = params.resource === null ? [] : [params.resource ?? MCP_RESOURCE].flat();
  for (const r of resources) q.append('resource', r);
  if (params.challenge !== null) {
    q.set('code_challenge', params.challenge ?? challenge);
    q.set('code_challenge_method', params.method ?? 'S256');
  }
  for (const [k, v] of Object.entries(params.extra ?? {})) q.set(k, v);
  return `/api/auth/oauth2/authorize?${q}`;
}

/** GET authorize in the user's browser; the `Location` it answers. */
export async function authorize(
  ctx: ListCtx,
  user: Caller | null,
  params: AuthorizeParams = {},
  challenge = pkce().challenge,
): Promise<URL> {
  const res = await ctx.app.request(authorizeUrl(params, challenge), {
    headers: user === null ? {} : { cookie: user.jar.header() },
  });
  const location = res.headers.get('location');
  expect(location, `authorize: ${res.status} ${await res.clone().text()}`).not.toBeNull();
  return new URL(location as string, BASE_URL);
}

/** The signed query the provider put on the consent page URL. */
export function oauthQueryOf(consentPage: URL): string {
  expect(consentPage.pathname).toBe('/oauth/consent');
  return consentPage.search.slice(1);
}

export async function consentRequest(user: Caller, consentPage: URL) {
  return user.ok<OAuthConsentRequest>(
    'GET',
    `/api/v1/oauth/consent?oauth_query=${encodeURIComponent(oauthQueryOf(consentPage))}`,
  );
}

export interface Decision {
  scopes?: GrantScope[];
  constraints?: GrantConstraints;
  expiresInDays?: number;
  sessionOnly?: boolean;
}

/** Allow, as the consent page does it: load the request in this session, then decide. */
export async function allow(user: Caller, consentPage: URL, decision: Decision = {}): Promise<URL> {
  await consentRequest(user, consentPage);
  const { redirectTo } = await user.ok<{ redirectTo: string }>('POST', '/api/v1/oauth/consent', {
    accept: true,
    oauthQuery: oauthQueryOf(consentPage),
    scopes: decision.scopes ?? ['tasks:read'],
    constraints: decision.constraints ?? { orgs: 'all' },
    ...(decision.expiresInDays === undefined ? {} : { expiresInDays: decision.expiresInDays }),
    ...(decision.sessionOnly === undefined ? {} : { sessionOnly: decision.sessionOnly }),
  });
  return new URL(redirectTo);
}

export async function tokenRequest(ctx: ListCtx, fields: Record<string, string | string[]>) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const item of [v].flat()) body.append(k, item);
  const res = await ctx.app.request('/api/auth/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

export async function exchange(
  ctx: ListCtx,
  code: string,
  verifier: string,
  extra: Record<string, string | string[]> = {},
) {
  return tokenRequest(ctx, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    ...extra,
  });
}

export async function refresh(ctx: ListCtx, refreshToken: string, clientId = CLIENT_ID) {
  return tokenRequest(ctx, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
}

export interface Tokens {
  access: string;
  refresh: string | undefined;
  scope: string;
  grantId: string;
}

/** The whole flow: authorize, consent (Allow), code exchange. */
export async function connect(
  ctx: ListCtx,
  user: Caller,
  params: AuthorizeParams = {},
  decision: Decision = {},
): Promise<Tokens> {
  const { verifier, challenge } = pkce();
  const page = await authorize(ctx, user, params, challenge);
  const back = page.pathname === '/oauth/consent' ? await allow(user, page, decision) : page;
  const code = back.searchParams.get('code');
  expect(code, back.href).not.toBeNull();
  expect(back.searchParams.get('iss')).toBe(ISSUER);
  const resource = params.resource === undefined ? MCP_RESOURCE : undefined;
  const token = await exchange(ctx, code as string, verifier, resource === undefined ? {} : {});
  expect(token.status, JSON.stringify(token.body)).toBe(200);
  const grants = await user.ok<{ id: string; clientId: string | null }[]>(
    'GET',
    '/api/v1/me/grants',
  );
  const grant = grants.find((g) => g.clientId === (params.clientId ?? CLIENT_ID));
  return {
    access: token.body.access_token as string,
    refresh: token.body.refresh_token as string | undefined,
    scope: token.body.scope as string,
    grantId: grant?.id ?? '',
  };
}

/** `Authorization: Bearer` requests (no cookie, no Origin). */
export async function withToken(
  ctx: ListCtx,
  token: string,
  method: string,
  path: string,
  body?: unknown,
) {
  return ctx.app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/**
 * Time passes for the tokens and grants: every timestamp the idle rule reads moves back by
 * `ms` (the provider stamps rows with the real clock, so the server clock stays put).
 */
export function age(ctx: ListCtx, ms: number): void {
  for (const table of [oauthRefreshToken, oauthAccessToken]) {
    for (const row of ctx.db.orm.select().from(table).all()) {
      if (row.createdAt === null) continue;
      ctx.db.orm
        .update(table)
        .set({ createdAt: new Date(row.createdAt.getTime() - ms) })
        .where(eq(table.id, row.id))
        .run();
    }
  }
  for (const row of ctx.db.orm.select().from(accessGrant).all()) {
    ctx.db.orm
      .update(accessGrant)
      .set({ updatedAt: row.updatedAt - ms, createdAt: row.createdAt - ms })
      .where(eq(accessGrant.id, row.id))
      .run();
  }
}
