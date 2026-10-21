import { hostname } from 'node:os';
import {
  createRoosterClient,
  RoosterApiError,
  type RoosterClient,
  type Schemas,
  type TokenSource,
  unwrap,
} from '@rooster/api-client';
import { uuidv7 } from '@rooster/core/ids';
import { CliError, EXIT } from './errors.ts';
import { currentLocale, t } from './i18n.ts';
import type { Io } from './io.ts';
import { clean } from './output/color.ts';
import { CLI_VERSION, CLIENT_NAME } from './version.ts';

const USER_AGENT = `rooster-cli/${CLI_VERSION} (${process.platform}; ${process.arch}; ${hostname()})`;

export type { RoosterClient };
export { RoosterApiError, unwrap };
export type Task = Schemas['Task'];
export type TaskDetail = Schemas['TaskDetail'];
export type Group = Schemas['Group'];
export type Tag = Schemas['Tag'];
export type Me = Schemas['Me'];
export type Org = Schemas['Org'];
export type Member = Schemas['Member'];
export type MyList = Schemas['MyList'];
export type Meta = Schemas['Meta'];
export type SearchHit = Schemas['SearchHit'];
export type Grant = Schemas['Grant'];
export type TokenCreate = Schemas['TokenCreate'];
export type TokenCreated = Schemas['TokenCreated'];

/**
 * RFC 6750 §2.1 `b64token`, bounded. A credential of any other shape (an embedded newline from
 * stdin or `ROOSTER_TOKEN`) never reaches `Headers.set`, whose error would quote it whole.
 */
const BEARER_TOKEN_RE = /^[A-Za-z0-9._~+/-]{1,4096}=*$/;

export function isBearerToken(token: string): boolean {
  return BEARER_TOKEN_RE.test(token);
}

/** A request that gets no response within this is reported as a network failure (exit 6). */
export const REQUEST_TIMEOUT_MS = 30_000;

export interface ApiOptions {
  server: string;
  /** A fixed token, or one read per request (refreshed when it is about to expire). */
  token: TokenSource | undefined;
  io: Io;
  /** `X-Rooster-Client-Id`: one per process. */
  clientId: string;
  /** `--verbose`: one stderr line per request. */
  verbose: boolean;
}

/**
 * The fetch every API call goes through: mutations get an `Idempotency-Key` and the edit time
 * (06 §1), every request a timeout, and a connection failure becomes exit code 6.
 */
export function cliFetch(options: Pick<ApiOptions, 'io' | 'verbose' | 'server'>) {
  const { io } = options;
  return async (request: Request): Promise<Response> => {
    const headers = new Headers(request.headers);
    // The `/device` page labels the grant "rooster CLI on <device>" from this.
    if (!headers.has('User-Agent')) headers.set('User-Agent', USER_AGENT);
    // Server problem details follow the CLI's language where the server has them.
    if (!headers.has('Accept-Language')) headers.set('Accept-Language', currentLocale());
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      if (!headers.has('Idempotency-Key')) headers.set('Idempotency-Key', uuidv7());
      if (!headers.has('X-Rooster-Edit-Time')) headers.set('X-Rooster-Edit-Time', String(io.now()));
    }
    const started = io.now();
    try {
      const response = await io.fetch(
        new Request(request, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
      );
      if (options.verbose) {
        io.stderr.write(
          `${request.method} ${new URL(request.url).pathname} → ${response.status} (${io.now() - started} ms)\n`,
        );
      }
      return response;
    } catch (error) {
      if (options.verbose) {
        io.stderr.write(`${request.method} ${request.url}: ${clean(String(error))}\n`);
      }
      throw new CliError(EXIT.network, t('error.network', { server: options.server }));
    }
  };
}

/** The typed client (`@rooster/api-client`) with the CLI's identity and credential. */
export function createApi(options: ApiOptions): RoosterClient {
  return createRoosterClient({
    baseUrl: options.server,
    ...(options.token === undefined ? {} : { token: options.token }),
    clientName: CLIENT_NAME,
    clientId: options.clientId,
    fetch: cliFetch(options),
  });
}

/** Grants, tokens and refs (Phase 8 routes). */
export const grantsApi = {
  list: (api: RoosterClient) => unwrap(api.GET('/api/v1/me/grants')),
  remove: (api: RoosterClient, id: string) =>
    unwrap(api.DELETE('/api/v1/me/grants/{id}', { params: { path: { id } } })),
  createToken: (api: RoosterClient, body: TokenCreate) =>
    unwrap(api.POST('/api/v1/me/tokens', { body })),
  /** `GET /tasks/resolve` (07 §3): `404`, or `409 ambiguous_ref` with `candidates`. */
  resolve: (api: RoosterClient, query: { ref: string; org?: string; deleted?: 'true' }) =>
    unwrap(api.GET('/api/v1/tasks/resolve', { params: { query } })),
};
