import createClient, { type Client, type ClientOptions, type Middleware } from 'openapi-fetch';
import type { components, operations, paths } from './schema';

export type { components, operations, paths };
export type RoosterClient = Client<paths>;

/** Every named DTO of the API, e.g. `Schemas['Task']`. */
export type Schemas = components['schemas'];

/** An RFC 9457 problem document with rooster's stable `code` (04 §4.10). */
export type Problem = components['schemas']['Problem'];

/** A bearer credential, or a function that yields one per request (`undefined`: send none). */
export type TokenSource = string | (() => string | undefined | Promise<string | undefined>);

export type RoosterClientOptions = Omit<ClientOptions, 'headers'> & {
  /**
   * Sent as `Authorization: Bearer <token>`: a session token from the CLI device flow or a
   * personal access token (`rooster_pat_…`). Omit it in the browser, where the session cookie
   * authenticates same-origin requests.
   */
  token?: TokenSource;
  /** `X-Rooster-Client`, recorded as `via` in activity entries, e.g. `cli/1.2.0` (06 §1). */
  clientName?: string;
  /**
   * `X-Rooster-Client-Id`, one per client instance (a tab or a process); echoed as `origin` in
   * SSE invalidations so a client can skip refetching its own changes.
   */
  clientId?: string;
  headers?: Record<string, string>;
};

/** Typed client for the rooster REST API, generated from the server's OpenAPI document. */
export function createRoosterClient(options: RoosterClientOptions = {}): RoosterClient {
  const { token, clientName, clientId, headers, ...rest } = options;
  const client = createClient<paths>({
    ...rest,
    headers: {
      ...headers,
      ...(clientName ? { 'X-Rooster-Client': clientName } : {}),
      ...(clientId ? { 'X-Rooster-Client-Id': clientId } : {}),
    },
  });
  if (token !== undefined) client.use(bearer(token));
  return client;
}

function bearer(token: TokenSource): Middleware {
  return {
    async onRequest({ request }) {
      const value = typeof token === 'function' ? await token() : token;
      if (value) request.headers.set('Authorization', `Bearer ${value}`);
      return request;
    },
  };
}

/** True for a problem+json body as the server sends it (`code`, `status` and `title`). */
export function isProblem(value: unknown): value is Problem {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.code === 'string' &&
    v.code.length > 0 &&
    typeof v.status === 'number' &&
    typeof v.title === 'string' &&
    typeof v.type === 'string'
  );
}

/** A non-2xx response. `code` is the problem's stable code, or `http_<status>` without one. */
export class RoosterApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly problem: Problem | undefined;

  constructor(status: number, problem: Problem | undefined) {
    super(problem?.detail ?? problem?.title ?? `HTTP ${status}`);
    this.name = 'RoosterApiError';
    this.status = status;
    this.code = problem?.code ?? `http_${status}`;
    this.problem = problem;
  }
}

/**
 * Resolves with the response data of an openapi-fetch call, or throws a `RoosterApiError`
 * for any non-2xx status.
 *
 * @example const me = await unwrap(api.GET('/api/v1/me'));
 */
export async function unwrap<T>(
  request: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await request;
  if (!response.ok) {
    throw new RoosterApiError(response.status, isProblem(error) ? error : undefined);
  }
  return data as T;
}
