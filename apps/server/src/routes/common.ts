import { z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppEnv } from '../lib/context.ts';
import { AppError } from '../lib/errors.ts';
import { EX } from '../lib/openapi-examples.ts';
import { GENERIC_CODES, PROBLEM_CODES, type ProblemCode } from '../lib/problem-codes.ts';
import { parseOpMeta } from '../lib/request-meta.ts';
import type { Actor, OpMeta } from '../services/index.ts';
import { ProblemSchema } from './problem.ts';

type Problem = z.infer<typeof ProblemSchema>;

export type ProblemStatus = 401 | 403 | 404 | 409 | 410 | 413 | 415 | 422 | 429 | 502 | 503;

const STATUS_TEXT: Record<ProblemStatus, string> = {
  401: 'Not signed in: no valid session cookie or bearer token',
  403: 'Not allowed: owner or admin only, a cross-origin cookie request, or outside the token’s grant',
  404: 'Not found, or not a member (existence is never revealed)',
  409: 'Conflicts with the current state',
  410: 'Gone: deleted, no longer valid, or expired',
  413: 'The request body is too large (1 MB)',
  415: 'Not JSON',
  422: 'Validation failed; `errors` lists the fields',
  429: 'Rate limited; retry after the Retry-After header',
  502: 'An upstream service (e.g. the push service) refused the request',
  503: 'The server is shutting down; retry shortly',
};

const STATUS_TITLES: Record<ProblemStatus, string> = {
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  410: 'Gone',
  413: 'Content Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

/** An example problem document for a code, as `lib/errors.ts` renders it. */
export function problemExample(code: ProblemCode): Problem {
  const { status, detail } = PROBLEM_CODES[code];
  return {
    type: 'about:blank',
    title: STATUS_TITLES[status as ProblemStatus],
    status,
    detail,
    code,
    ...(code === 'ambiguous_ref'
      ? {
          candidates: [
            {
              id: '0192f3a0-6c1d-7e2a-9b3c-4d5e6f708192',
              orgId: EX.org,
              seq: 42,
              title: 'Pay invoice',
            },
            {
              id: '0192f3a0-7d2e-7f3b-8c4d-5e6f70819203',
              orgId: EX.org,
              seq: 57,
              title: 'Pay rent',
            },
          ],
        }
      : {}),
    ...(code === 'ambiguous_member'
      ? {
          members: [
            { userId: EX.user, name: 'Bo Ek' },
            { userId: EX.otherUser, name: 'Bo Ek' },
          ],
        }
      : {}),
    ...(code === 'storage_quota_exceeded'
      ? { limitBytes: 1_073_741_824, usedBytes: 1_060_000_000 }
      : {}),
    ...(status === 422 && code !== 'idempotency_key_reuse'
      ? {
          errors: [{ path: 'title', message: 'Too small: expected string to have >=1 characters' }],
        }
      : {}),
  };
}

type ProblemResponse = {
  description: string;
  content: {
    'application/problem+json': {
      schema: typeof ProblemSchema;
      examples: Record<string, { summary: string; value: Problem }>;
    };
  };
};

/**
 * problem+json responses for the OpenAPI document. Pass statuses and route-specific codes,
 * e.g. `problems(...AUTHED, 404, 'id_conflict')`: a code adds its status. Every status lists
 * its codes as named examples: the generic ones (`GENERIC_CODES`) plus the route's own. A
 * route that can answer 401 is authenticated, so 403 (grant checks) and 429 (the per-user
 * rate limit) are added too. A status without any code (409, 410, 502) fails the
 * documentation test (contract.test.ts).
 */
/**
 * Marks a read route that every credential may call: no capability or browser-only check, so
 * no 403 (e.g. `GET /me`, which the CLI needs whatever its grant).
 */
export const ANY_CREDENTIAL = 'any-credential';

export function problems(
  ...items: (ProblemStatus | ProblemCode | typeof ANY_CREDENTIAL)[]
): Record<number, ProblemResponse> {
  const codes = new Map<ProblemStatus, ProblemCode[]>();
  const add = (status: ProblemStatus, list: readonly ProblemCode[]) => {
    const current = codes.get(status) ?? [];
    for (const code of list) if (!current.includes(code)) current.push(code);
    codes.set(status, current);
  };
  const statuses = new Set<ProblemStatus>();
  const anyCredential = items.includes(ANY_CREDENTIAL);
  const codeItems = items.filter(
    (i): i is ProblemCode => typeof i === 'string' && i !== ANY_CREDENTIAL,
  );
  for (const item of items) if (typeof item === 'number') statuses.add(item);
  for (const item of codeItems) statuses.add(PROBLEM_CODES[item].status as ProblemStatus);
  const authenticated = statuses.has(401);
  if (authenticated) {
    if (!anyCredential) statuses.add(403);
    statuses.add(429);
  }
  for (const status of [...statuses].sort()) {
    // Grant checks (403) need a credential: a public route lists its own 403 codes.
    if (status !== 403 || authenticated) add(status, GENERIC_CODES[status] ?? []);
  }
  for (const item of codeItems) add(PROBLEM_CODES[item].status as ProblemStatus, [item]);
  return Object.fromEntries(
    [...codes].map(([status, list]) => [
      status,
      {
        description: STATUS_TEXT[status],
        content: {
          'application/problem+json': {
            schema: ProblemSchema,
            examples: Object.fromEntries(
              list.map((code) => [
                code,
                { summary: PROBLEM_CODES[code].detail, value: problemExample(code) },
              ]),
            ),
          },
        },
      },
    ]),
  );
}

/** Errors every authenticated mutation can return (403 and 429 follow from 401). */
export const AUTHED: ProblemStatus[] = [401, 413, 415, 422];

export function json<T extends z.ZodType>(schema: T, description: string) {
  return { description, content: { 'application/json': { schema } } };
}

export function body<T extends z.ZodType>(schema: T) {
  return { required: true, content: { 'application/json': { schema } } };
}

/** A JSON body that may be omitted entirely (then it is treated as `{}`). */
export function optionalBody<T extends z.ZodType>(schema: T) {
  return { required: false, content: { 'application/json': { schema } } };
}

export const orgIdParam = z
  .string()
  .min(1)
  .openapi({
    param: { name: 'orgId', in: 'path' },
    description: 'Org ID, slug, or `personal` for your personal org.',
    example: 'personal',
  });

export function idParam(name: string, description: string) {
  return z
    .string()
    .min(1)
    .openapi({ param: { name, in: 'path' }, description });
}

/** The actor set by the actor middleware; every non-public route has one. */
export function actorOf(c: Context<AppEnv>): Actor {
  const actor = c.get('actor');
  if (actor === undefined) throw new AppError('unauthenticated', 401, 'Sign in to continue.');
  return actor;
}

/** Edit time and client identity of the request (set by the request-meta middleware). */
export function metaOf(c: Context<AppEnv>): OpMeta {
  return c.get('opMeta') ?? parseOpMeta({}, Date.now());
}
