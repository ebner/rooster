import type { OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import type { ZodType } from 'zod';
import type { AppEnv } from './context.ts';
import type { Logger } from './logger.ts';
import { loggablePath } from './request-log.ts';

/**
 * The response contract of the OpenAPI document (06 §4, 10 §3, AC-8.4): for every route, the
 * declared statuses and, per status, the media types and the zod schema of a JSON body. Built
 * from the zod-openapi registry, so it is exactly what the document is generated from.
 */
export interface RouteContract {
  method: string;
  /** The OpenAPI path template, e.g. `/api/v1/tasks/{id}`. */
  path: string;
  responses: Map<number, ResponseContract>;
  /** Matches a concrete request path. */
  pattern: RegExp;
  params: number;
}

export interface ResponseContract {
  /** Media type → zod schema (JSON types) or null (streams, files, text). */
  content: Map<string, ZodType | null>;
}

export interface ResponseViolation {
  method: string;
  /** The concrete request path. */
  path: string;
  /** The matched route (`METHOD /template`), or null for an undocumented route. */
  route: string | null;
  status: number;
  kind:
    | 'undocumented_route'
    | 'undeclared_status'
    | 'unexpected_body'
    | 'content_type'
    | 'invalid_json'
    | 'schema';
  message: string;
  issues?: { path: string; message: string }[];
  at: number;
}

const JSON_TYPES = new Set(['application/json', 'application/problem+json']);

function isZodType(value: unknown): value is ZodType {
  return typeof value === 'object' && value !== null && 'safeParse' in value;
}

/** Every route the app documents, most specific (fewest path parameters) first. */
export function routeContracts(app: Pick<OpenAPIHono<AppEnv>, 'openAPIRegistry'>): RouteContract[] {
  const contracts: RouteContract[] = [];
  for (const def of app.openAPIRegistry.definitions) {
    if (def.type !== 'route') continue;
    const { method, path } = def.route;
    const responses = new Map<number, ResponseContract>();
    for (const [status, response] of Object.entries(def.route.responses)) {
      const content = new Map<string, ZodType | null>();
      const declared = (response as { content?: Record<string, { schema?: unknown }> }).content;
      for (const [type, media] of Object.entries(declared ?? {})) {
        content.set(type, JSON_TYPES.has(type) && isZodType(media.schema) ? media.schema : null);
      }
      responses.set(Number(status), { content });
    }
    const source = path
      .split(/\{[^}]+\}/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]+');
    contracts.push({
      method: method.toUpperCase(),
      path,
      responses,
      pattern: new RegExp(`^${source}$`),
      params: (path.match(/\{/g) ?? []).length,
    });
  }
  return contracts.sort((a, b) => a.params - b.params);
}

export function findContract(
  contracts: readonly RouteContract[],
  method: string,
  path: string,
): RouteContract | undefined {
  const m = method.toUpperCase();
  return contracts.find((c) => c.method === m && c.pattern.test(path));
}

/**
 * Checks one response against its route's contract. Reads the body of JSON responses only
 * (from a clone); streams and downloads are checked by status and media type.
 */
export async function checkResponse(
  contract: RouteContract,
  request: { method: string; path: string },
  res: Response,
  now: number,
): Promise<ResponseViolation | null> {
  const route = `${contract.method} ${contract.path}`;
  const base = { method: request.method, path: request.path, route, status: res.status, at: now };
  const declared = contract.responses.get(res.status);
  if (declared === undefined) {
    return { ...base, kind: 'undeclared_status', message: `${res.status} is not declared` };
  }
  const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (declared.content.size === 0) {
    const text = res.body === null ? '' : await res.clone().text();
    return text === ''
      ? null
      : { ...base, kind: 'unexpected_body', message: 'A body where none is declared' };
  }
  // A download of whatever a user attached is declared as `*/*` (or `image/*`).
  const declaredType = [type, `${type.split('/')[0]}/*`, '*/*'].find((t) =>
    declared.content.has(t),
  );
  if (type === '' || declaredType === undefined) {
    const expected = [...declared.content.keys()].join(', ');
    return { ...base, kind: 'content_type', message: `${type || 'no type'}, expected ${expected}` };
  }
  const schema = declared.content.get(declaredType);
  if (schema === undefined || schema === null) return null;
  let body: unknown;
  try {
    body = JSON.parse(await res.clone().text());
  } catch {
    return { ...base, kind: 'invalid_json', message: 'The body is not JSON' };
  }
  const parsed = schema.safeParse(body);
  if (parsed.success) return null;
  return {
    ...base,
    kind: 'schema',
    message: 'The body does not match the declared schema',
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    })),
  };
}

/** Violations recorded by `responseValidation`, served at `RESPONSE_VIOLATIONS_PATH`. */
export class ResponseViolations {
  readonly list: ResponseViolation[] = [];
  /** Responses checked so far; lets the e2e harness see that validation is on. */
  checked = 0;

  record(violation: ResponseViolation): void {
    this.list.push(violation);
  }
}

/** Test-only (AC-8.4): exists only while response validation is switched on. */
export const RESPONSE_VIOLATIONS_PATH = '/__test/response-violations';

/**
 * AC-8.4: validates every `/api/v1` response against the OpenAPI document and records each
 * mismatch (logged as an error). Mounted only with `ROOSTER_VALIDATE_RESPONSES=1` (the e2e
 * servers), so it costs nothing otherwise. It never changes a response.
 */
export function responseValidation(
  app: Pick<OpenAPIHono<AppEnv>, 'openAPIRegistry'>,
  violations: ResponseViolations,
  deps: { logger: Logger; clock: () => number; ignore?: readonly string[] },
): MiddlewareHandler<AppEnv> {
  let contracts: RouteContract[] | undefined;
  const ignore = new Set(deps.ignore ?? []);
  return async (c, next) => {
    await next();
    const { method } = c.req;
    if (ignore.has(c.req.path)) return;
    // Recorded and logged with invite tokens redacted, like the request log.
    const path = loggablePath(c.req.path);
    // Built on first use: every route is registered by then.
    contracts ??= routeContracts(app);
    violations.checked += 1;
    const contract = findContract(contracts, method, c.req.path);
    let violation: ResponseViolation | null;
    if (contract === undefined) {
      violation =
        c.res.status === 404
          ? null
          : {
              method,
              path,
              route: null,
              status: c.res.status,
              kind: 'undocumented_route',
              message: 'No route in the OpenAPI document matches',
              at: deps.clock(),
            };
    } else {
      violation = await checkResponse(contract, { method, path }, c.res, deps.clock());
    }
    if (violation === null) return;
    violations.record(violation);
    deps.logger.error(
      { violation, reqId: c.get('requestId') },
      'response violates the OpenAPI contract',
    );
  };
}
