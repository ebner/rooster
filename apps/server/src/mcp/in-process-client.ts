import { createRoosterClient, type RoosterClient } from '@rooster/api-client';
import { IN_PROCESS_ACTOR, type InProcessBindings } from '../lib/in-process.ts';
import type { Actor } from '../services/context.ts';

/** The app's own `fetch`, as `createApp` returns it. */
export type AppFetch = (request: Request, env: InProcessBindings) => Response | Promise<Response>;

/** The only paths the tools may reach: the public REST API. */
const API_PREFIX = '/api/v1/';

/**
 * Request headers that must never reach the in-process REST call: credentials (the OAuth token
 * stays at the edge, 11 §7) and anything a route could read as the caller's network identity.
 * The client builds its requests from scratch, so these are absent anyway; dropping them keeps
 * that true whatever a future client middleware adds.
 */
const DROPPED_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
];

export interface InProcessClientOptions {
  appFetch: AppFetch;
  actor: Actor;
  /** `ROOSTER_BASE_URL`: the client's base URL, so every route resolves as over HTTP. */
  baseUrl: string;
  /** `X-Rooster-Client: mcp/<version>`, which activity records as `via: mcp` (06 §1). */
  version: string;
}

/**
 * A REST client whose requests go straight into `app.fetch` with the already resolved actor
 * (ADR 0042 §5): routes, service authorisation, the per-user rate limit, idempotency and
 * activity attribution all apply unchanged, and nothing leaves the process.
 */
export function createInProcessClient(options: InProcessClientOptions): RoosterClient {
  const origin = new URL(options.baseUrl).origin;
  const fetchInProcess = async (input: Request): Promise<Response> => {
    const url = new URL(input.url);
    // WHATWG URL parsing has already resolved `..` and `%2e` segments here.
    if (url.origin !== origin || !url.pathname.startsWith(API_PREFIX)) {
      throw new Error('The in-process MCP client may only call the REST API.');
    }
    const headers = new Headers(input.headers);
    for (const name of DROPPED_HEADERS) headers.delete(name);
    headers.set('x-rooster-client', `mcp/${options.version}`);
    const body =
      input.body === null || input.method === 'GET' || input.method === 'HEAD'
        ? undefined
        : await input.arrayBuffer();
    const request = new Request(url, {
      method: input.method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: input.signal,
    });
    return options.appFetch(request, { [IN_PROCESS_ACTOR]: options.actor });
  };
  return createRoosterClient({
    baseUrl: options.baseUrl,
    clientName: `mcp/${options.version}`,
    fetch: fetchInProcess,
  });
}
