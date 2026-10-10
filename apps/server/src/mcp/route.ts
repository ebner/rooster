import type { OpenAPIHono } from '@hono/zod-openapi';
import { createMcpHandler, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/server';
import { ALL_GRANT_SCOPES, type GrantScope } from '@rooster/core/grants';
import { createRoosterMcpServer } from '@rooster/mcp';
import { coversScopes, isToolName, requiredScopes } from '@rooster/mcp/tools';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { resolveOAuthBearer } from '../auth/oauth-bearer.ts';
import { API_BODY_LIMIT, readBodyBounded } from '../lib/body-limit.ts';
import { clientIp } from '../lib/client-ip.ts';
import type { AppEnv } from '../lib/context.ts';
import { logSafeError } from '../lib/log-safe-error.ts';
import { type RateLimitOptions, SlidingWindowLimiter } from '../lib/rate-limit.ts';
import type { P9RouteDeps } from '../routes/p9-deps.ts';
import type { Actor } from '../services/context.ts';
import {
  MCP_BASE_SCOPE,
  MCP_PATH,
  MCP_RESOURCE_METADATA_PATH,
  mcpChallenge,
  mcpProtectedResourceMetadata,
  PROTECTED_RESOURCE_WELL_KNOWN,
} from './challenge.ts';
import { type AppFetch, createInProcessClient } from './in-process-client.ts';
import { echoId, jsonRpcError, toolCallsOf } from './jsonrpc.ts';

/** 11 §5.2: tool calls per grant and minute (the per-user API limit applies on top). */
export const MCP_TOOL_CALL_LIMIT: RateLimitOptions = { max: 120, windowMs: 60_000 };
/** The largest tool call is a task with a 100,000-character description, as on the API. */
export const MCP_BODY_LIMIT = API_BODY_LIMIT;
/** The protocol revision the endpoint is built for (11 §5.2). */
export const MCP_PROTOCOL_VERSION = '2026-07-28';
/**
 * Every revision the endpoint answers: 2026-07-28 natively, and the 2025-era revisions through
 * the SDK's stateless fallback, since most clients still speak those. The Server Card lists
 * the same set.
 */
export const MCP_SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  MCP_PROTOCOL_VERSION,
  ...SUPPORTED_PROTOCOL_VERSIONS,
];
/**
 * Open `subscriptions/listen` streams across all grants. rooster's tool list never changes,
 * so a listener only ever receives keep-alives; the cap keeps idle streams from piling up.
 */
const MAX_LISTEN_STREAMS = 64;
/** A bearer value longer than this is not one of ours; it is rejected before any lookup. */
const MAX_TOKEN_LENGTH = 512;

/** JSON-RPC codes for answers the HTTP layer gives itself (SDK conventions). */
const RPC_PARSE_ERROR = -32700;
const RPC_SERVER_ERROR = -32000;

const NO_STORE = 'no-store';

/** `Authorization: Bearer <token>` only (RFC 6750 §2.1); query and body tokens are ignored. */
function bearerToken(header: string | undefined): string | null {
  if (header === undefined || header.slice(0, 7).toLowerCase() !== 'bearer ') return null;
  const token = header.slice(7).trim();
  return token === '' ? null : token;
}

function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) return false;
  return value.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

/**
 * Streamable HTTP: a POST's `Accept` lists both `application/json` and `text/event-stream`.
 * The SDK checks this only for 2025-era requests; the endpoint applies it to every revision.
 */
function acceptsMcpResponses(value: string | undefined): boolean {
  if (value === undefined) return false;
  const types = value.split(',').map((part) => part.split(';')[0]?.trim().toLowerCase());
  return types.includes('application/json') && types.includes('text/event-stream');
}

function hasAssigneeArg(args: unknown): boolean {
  return typeof args === 'object' && args !== null && 'assignee' in args;
}

/**
 * The body as text, or null once it exceeds `maxBytes`: a declared `Content-Length` is checked
 * up front, a chunked body is counted while it is read and cut off at the bound.
 */
export async function readBoundedText(request: Request, maxBytes: number): Promise<string | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) return null;
  if (request.body === null) return '';
  // One growing buffer, never an object per chunk (a body dribbled in 1-byte chunks).
  const bytes = await readBodyBounded(request.body, maxBytes);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

/** Scopes in `ALL_GRANT_SCOPES` order, without duplicates, for a stable challenge. */
function orderedScopes(scopes: Iterable<GrantScope>): GrantScope[] {
  const set = new Set(scopes);
  return ALL_GRANT_SCOPES.filter((s) => set.has(s));
}

function rpcResponse(
  c: Context<AppEnv>,
  status: ContentfulStatusCode,
  code: number,
  message: string,
  id: string | number | null = null,
  headers: Record<string, string> = {},
): Response {
  for (const [name, value] of Object.entries(headers)) c.header(name, value);
  c.header('Cache-Control', NO_STORE);
  return c.json(jsonRpcError(code, message, id), status);
}

/** RFC 9728 metadata responses are public and cacheable; CORS lets browser clients read them. */
function setMetadataHeaders(c: Context<AppEnv>): void {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, MCP-Protocol-Version');
  c.header('Cache-Control', 'public, max-age=3600');
}

/**
 * The remote MCP endpoint (11 §5.2, ADR 0042), outside `/api/v1` and the OpenAPI document:
 *
 * - `POST /mcp`: Streamable HTTP, stateless, one `McpServer` per request (protocol 2026-07-28;
 *   2025-era clients through the SDK's stateless fallback). `GET` and `DELETE` are `405`: a
 *   stateless server has no standalone SSE stream and no session to end.
 * - `Origin`, when present, must be `ROOSTER_BASE_URL`'s origin (DNS rebinding, MCP transport
 *   security); non-browser clients send none.
 * - Auth is an OAuth access token bound to the `mcp` resource, from `Authorization` only. No
 *   token or an invalid one: `401` with the RFC 9728 challenge. A `tools/call` beyond the
 *   grant's scopes: `403 insufficient_scope` naming every scope it needs, before the SDK runs.
 * - 120 tool calls per grant and minute (`429` with `Retry-After`).
 * - Tools run against the REST API in-process with the resolved actor; the token never leaves
 *   this handler, and the SDK never sees it.
 */
export function registerMcpRoutes(app: OpenAPIHono<AppEnv>, deps: P9RouteDeps): void {
  const { config, services, logger, clock, version } = deps;
  const expectedOrigin = new URL(config.baseUrl).origin;
  const limiter = new SlidingWindowLimiter(MCP_TOOL_CALL_LIMIT);
  const appFetch: AppFetch = (request, env) => app.fetch(request, env);

  // The factory gets the request the handler was called with; the actor rides along in a
  // WeakMap rather than in `authInfo`, which would have to carry a token.
  const actors = new WeakMap<Request, Actor>();
  const handler = createMcpHandler(
    (ctx) => {
      const actor = ctx.requestInfo === undefined ? undefined : actors.get(ctx.requestInfo);
      if (actor?.grant == null) throw new Error('MCP request without a resolved grant');
      return createRoosterMcpServer({
        client: createInProcessClient({ appFetch, actor, baseUrl: config.baseUrl, version }),
        listing: { mode: 'step-up', scopes: actor.grant.scopes },
        instanceUrl: config.baseUrl,
        version,
        defaultOrg: null,
        onError: (err, tool) =>
          logger.warn({ err: logSafeError(err), tool }, 'mcp: tool failed unexpectedly'),
      });
    },
    {
      maxRequestBodySize: MCP_BODY_LIMIT,
      maxSubscriptions: MAX_LISTEN_STREAMS,
      // Rejected and failed exchanges. Their messages may quote request content, so debug only.
      onerror: (err) => logger.debug({ err: logSafeError(err) }, 'mcp: exchange failed'),
    },
  );

  const metadata = (c: Context<AppEnv>) => {
    setMetadataHeaders(c);
    return c.json(mcpProtectedResourceMetadata(config));
  };
  const preflight = (c: Context<AppEnv>) => {
    setMetadataHeaders(c);
    return c.body(null, 204);
  };
  // RFC 9728 §3.1 for the `/mcp` resource, and at the root for clients that probe it first.
  for (const path of [MCP_RESOURCE_METADATA_PATH, PROTECTED_RESOURCE_WELL_KNOWN]) {
    app.get(path, metadata);
    app.options(path, preflight);
  }

  app.all(MCP_PATH, async (c) => {
    const origin = c.req.header('origin');
    if (origin !== undefined && origin !== expectedOrigin) {
      return rpcResponse(c, 403, RPC_SERVER_ERROR, 'Forbidden: invalid Origin header.');
    }
    if (c.req.method !== 'POST') {
      return rpcResponse(c, 405, RPC_SERVER_ERROR, 'Method not allowed.', null, { Allow: 'POST' });
    }

    const token = bearerToken(c.req.header('authorization'));
    if (token === null) {
      return rpcResponse(
        c,
        401,
        RPC_SERVER_ERROR,
        'Unauthorized: an OAuth access token is required.',
        null,
        {
          'WWW-Authenticate': mcpChallenge(config, { scope: [MCP_BASE_SCOPE] }),
        },
      );
    }
    const resolve = () =>
      token.length > MAX_TOKEN_LENGTH
        ? Promise.resolve(null)
        : resolveOAuthBearer(services, token, 'mcp', clientIp(c, config));
    const early = await resolve();
    if (early?.grant == null) {
      return rpcResponse(
        c,
        401,
        RPC_SERVER_ERROR,
        'Unauthorized: the access token is invalid.',
        null,
        {
          'WWW-Authenticate': mcpChallenge(config, {
            error: 'invalid_token',
            scope: [MCP_BASE_SCOPE],
          }),
        },
      );
    }

    if (!isJsonContentType(c.req.header('content-type'))) {
      return rpcResponse(
        c,
        415,
        RPC_SERVER_ERROR,
        'Unsupported Media Type: send application/json.',
      );
    }
    if (!acceptsMcpResponses(c.req.header('accept'))) {
      return rpcResponse(
        c,
        406,
        RPC_SERVER_ERROR,
        'Not Acceptable: accept both application/json and text/event-stream.',
      );
    }
    // Read only now, after the cheap checks, so a rejected request never waits for its body.
    const text = await readBoundedText(c.req.raw, MCP_BODY_LIMIT);
    if (text === null) {
      return rpcResponse(
        c,
        413,
        RPC_SERVER_ERROR,
        `Content Too Large: the body exceeds ${MCP_BODY_LIMIT / 1024} KB.`,
      );
    }
    // The body may have taken a while: resolve the token again, so a grant revoked or narrowed
    // meanwhile never runs a call with the permissions it had when the request started.
    const actor = await resolve();
    if (actor?.grant == null) {
      return rpcResponse(
        c,
        401,
        RPC_SERVER_ERROR,
        'Unauthorized: the access token is invalid.',
        null,
        {
          'WWW-Authenticate': mcpChallenge(config, {
            error: 'invalid_token',
            scope: [MCP_BASE_SCOPE],
          }),
        },
      );
    }
    const grant = actor.grant;
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return rpcResponse(c, 400, RPC_PARSE_ERROR, 'Parse error: the body is not valid JSON.');
    }

    // Scope challenge (MCP Scope Challenge Handling, ADR 0042 §6): every scope the request
    // needs, in one challenge. The services enforce the same rules again on each REST call.
    const calls = toolCallsOf(body);
    // An exact display name also counts as "me" (ADR 0044 §1). The actor carries no name, so
    // it is read once, and only when some call names an assignee.
    const name = calls.some((call) => hasAssigneeArg(call.args))
      ? services.users.getMe(actor).name
      : undefined;
    const scopeContext = { userId: actor.userId, email: actor.email, name };
    const needed = new Set<GrantScope>();
    let missing = false;
    for (const call of calls) {
      if (!isToolName(call.name)) continue; // Unknown tools are the SDK's to reject.
      const scopes = requiredScopes(call.name, call.args, scopeContext);
      for (const scope of scopes) needed.add(scope);
      if (!coversScopes(grant.scopes, scopes)) missing = true;
    }
    if (missing) {
      return rpcResponse(c, 403, RPC_SERVER_ERROR, 'Forbidden: insufficient scope.', echoId(body), {
        'WWW-Authenticate': mcpChallenge(config, {
          error: 'insufficient_scope',
          scope: orderedScopes(needed),
        }),
      });
    }

    const now = clock();
    for (let i = 0; i < calls.length; i += 1) {
      const waitMs = limiter.hit(grant.id, now);
      if (waitMs > 0) {
        return rpcResponse(
          c,
          429,
          RPC_SERVER_ERROR,
          'Too many tool calls; slow down.',
          echoId(body),
          {
            'Retry-After': String(Math.ceil(waitMs / 1000)),
          },
        );
      }
    }

    // The SDK, and through `requestInfo` every tool, sees this request: without credentials.
    const headers = new Headers(c.req.raw.headers);
    headers.delete('authorization');
    headers.delete('cookie');
    const request = new Request(c.req.url, {
      method: 'POST',
      headers,
      body: text,
      signal: c.req.raw.signal,
    });
    actors.set(request, actor);
    const response = await handler.fetch(request, { parsedBody: body });
    const out = new Response(response.body, response);
    out.headers.set('Cache-Control', NO_STORE);
    return out;
  });
}
