import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from '@hono/zod-openapi';
import type { AppEnv } from './context.ts';
import { COMPONENT_EXAMPLES } from './openapi-examples.ts';
import { type ProblemCode, UNSAFE_ONLY_CODES } from './problem-codes.ts';

type Metadata = Parameters<z.ZodType['openapi']>[1];

/**
 * Registers a shared schema from @rooster/core as a named OpenAPI component, with its example
 * from `COMPONENT_EXAMPLES` unless `metadata` brings one.
 *
 * Zod 4 copies methods onto each schema instance when it is constructed, so a core schema
 * created before `@hono/zod-openapi` was first imported has no `.openapi()`. A clone is
 * constructed now, after the extension, and behaves identically.
 */
export function named<T extends z.ZodType>(schema: T, name: string, metadata?: Metadata): T {
  const example = COMPONENT_EXAMPLES[name];
  const component = schema
    .clone()
    .openapi(name, { ...(example === undefined ? {} : { example }), ...metadata }) as T;
  NAMED_SCHEMAS.set(name, component);
  return component;
}

/** Every component registered through `named()`; the contract test parses their examples. */
export const NAMED_SCHEMAS = new Map<string, z.ZodType>();

/**
 * Field descriptions for an object schema, for the OpenAPI document. The fields keep their
 * validation; only `description` metadata is added.
 */
export function describe<T extends z.ZodObject>(
  schema: T,
  fields: Partial<Record<keyof T['shape'] & string, string>>,
): T {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, description] of Object.entries(fields)) {
    const field = schema.shape[key] as z.ZodType | undefined;
    if (field === undefined || typeof description !== 'string') {
      throw new Error(`describe(): no field ${key}`);
    }
    shape[key] = field.meta({ description });
  }
  // `safeExtend` keeps the object's refinements (e.g. the due-unit consistency check).
  return schema.safeExtend(shape) as unknown as T;
}

export { z };

export const OPENAPI_TAGS: { name: string; description: string }[] = [
  {
    name: 'meta',
    description: 'Server version, sign-in providers and enabled features. No authentication.',
  },
  {
    name: 'me',
    description:
      'The signed-in user: profile, settings, the sidebar order of orgs, and sessions. Settings routes need the browser session.',
  },
  {
    name: 'orgs',
    description:
      'Organisations, members and invites. `{orgId}` accepts an org ID, its slug, or `personal`. Non-members always get `404`.',
  },
  {
    name: 'invites',
    description:
      'The invite link flow: preview and claim work without a session (the `/invite/:token` page), accept joins as the signed-in user.',
  },
  {
    name: 'list',
    description:
      'My list: my personal groups in an org and every task placed in them. Groups and placements are per user (D-02); nobody else sees them.',
  },
  {
    name: 'tasks',
    description:
      'Tasks are shared by every member of their org. Writes are last-write-wins per field (`X-Rooster-Edit-Time`), idempotent with `Idempotency-Key`, and positions are computed by the server from `afterId`/`beforeId` intents.',
  },
  { name: 'tags', description: 'Org-wide tags and the tags on a task.' },
  {
    name: 'collaboration',
    description: 'Comments, the activity feed and followers of tasks in shared orgs.',
  },
  {
    name: 'notifications',
    description: 'My in-app notifications and the notification preference matrix.',
  },
  { name: 'push', description: 'Web Push subscriptions of my devices.' },
  {
    name: 'search',
    description: 'Full-text search over the tasks of my orgs, with filters.',
  },
  { name: 'export', description: 'Download my data in an org as JSON or Markdown.' },
  {
    name: 'events',
    description: 'Server-Sent Events that tell clients which queries to refetch.',
  },
  {
    name: 'admin',
    description:
      'Instance administration: the sign-in allowlist, users, backups, the search index and push keys. Instance admins with a browser session only.',
  },
];

const SECURITY_SCHEMES = {
  cookieSession: {
    type: 'apiKey',
    in: 'cookie',
    name: 'rooster.session',
    description:
      'The browser session set by signing in at `/api/auth/*` (named `__Host-rooster.session` on https). **CSRF:** with cookie auth, `POST`, `PUT`, `PATCH` and `DELETE` must send an `Origin` header equal to the instance URL (`403 csrf_origin`) and a JSON body (`415 unsupported_media_type`). It is the only credential for settings, org administration, admin, export, push and token routes (others get `403 forbidden_scope`).',
  },
  bearerSession: {
    type: 'http',
    scheme: 'bearer',
    description:
      'A session token from the CLI device flow (`rooster login`), sent as `Authorization: Bearer <token>`. Bearer requests are exempt from the CSRF Origin rule. The token carries a grant: capabilities and org/group constraints (`403 forbidden_scope`, `403 outside_grant`).',
  },
  personalAccessToken: {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'rooster_pat_…',
    description:
      'A personal access token created in Settings → Connected apps or with `rooster token create`, sent as `Authorization: Bearer rooster_pat_…`. Like a device session it carries a grant: a missing capability is `403 forbidden_scope`, a target outside its orgs or groups `403 outside_grant`.',
  },
} as const;

const REQUEST_HEADERS = {
  IdempotencyKey: {
    name: 'Idempotency-Key',
    in: 'header',
    required: false,
    description:
      'Makes a mutation safe to retry: a replay with the same key within 7 days returns the original status and body (with `Idempotent-Replayed: true`) without running it again. The same key on a different request is `422 idempotency_key_reuse`. 1–128 characters of `[A-Za-z0-9_-]`; a UUID is a good choice.',
    schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' },
    example: '0199c5a2-7d3e-7b41-9a0c-3f5e8d2b1a60',
  },
  EditTime: {
    name: 'X-Rooster-Edit-Time',
    in: 'header',
    required: false,
    description:
      'When the user made the edit (ms epoch), for per-field last-write-wins: a field older than the stored edit is skipped and listed in `ignoredFields`. Defaults to the server’s clock; clamped to [now − 30 days, now + 5 s]. Offline clients send the original edit time when they replay.',
    schema: { type: 'string', pattern: '^\\d{1,16}$' },
    example: '1767225600000',
  },
  ClientId: {
    name: 'X-Rooster-Client-Id',
    in: 'header',
    required: false,
    description:
      'Identifies one client instance (a browser tab or a process); echoed as `origin` in the `invalidate` events this request causes, so the client can skip refetching its own change. 1–64 characters of `[A-Za-z0-9_-]`.',
    schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
    example: 'tab-0199c5a2',
  },
  Client: {
    name: 'X-Rooster-Client',
    in: 'header',
    required: false,
    description:
      'The kind of client and its version, recorded as `via` in activity entries: `web`, `pwa`, `cli`, `tui` or `mcp`, optionally followed by `/<version>`.',
    schema: { type: 'string', pattern: '^[a-z]+(?:/[A-Za-z0-9._+-]{1,32})?$' },
    example: 'cli/1.2.0',
  },
} as const;

const RESPONSE_HEADERS = {
  RetryAfter: {
    description: 'Seconds until the next request is allowed.',
    required: true,
    schema: { type: 'string', pattern: '^\\d+$' },
    example: '12',
  },
  IdempotentReplayed: {
    description:
      '`true` when this is the stored response of an earlier request with the same `Idempotency-Key`.',
    required: false,
    schema: { type: 'string', enum: ['true'] },
  },
} as const;

const PARAMETER_DESCRIPTIONS: Record<string, string> = {
  cursor: 'Opaque cursor: the `nextCursor` of the previous page. Omit it for the first page.',
  limit: 'Page size.',
};

const SAFE_METHODS = new Set(['get', 'head', 'options']);

function quickStart(baseUrl: string): string {
  return [
    'The REST API of a rooster instance: a keyboard-first, self-hosted task manager.',
    '',
    '## Quick start',
    '',
    '1. Create a personal access token in **Settings → Connected apps** (or `rooster token create my-script --scope tasks:read,tasks:write`). It is shown once.',
    '2. Send it as a bearer token:',
    '',
    '```sh',
    `curl -H "Authorization: Bearer $ROOSTER_TOKEN" ${baseUrl}/api/v1/me`,
    '',
    `curl -X POST ${baseUrl}/api/v1/orgs/personal/tasks \\`,
    '  -H "Authorization: Bearer $ROOSTER_TOKEN" \\',
    '  -H "Content-Type: application/json" \\',
    '  -H "Idempotency-Key: $(uuidgen)" \\',
    `  -d '{"title": "Pay invoice tomorrow >Prio", "parse": true}'`,
    '```',
    '',
    'The `rooster` CLI wraps this API (`rooster login`, `rooster add "Pay invoice tom >Prio"`, `rooster ls --json`), and `@rooster/api-client` is a typed TypeScript client generated from this document.',
    '',
    '## Authentication',
    '',
    '- **Browser session cookie:** everything, including settings, org administration, admin, export, push subscriptions and creating tokens.',
    '- **Bearer credentials** (a CLI device session or a PAT) carry a grant: capabilities such as `tasks:read` and `tasks:write`, limited to chosen orgs and groups. A missing capability is `403 forbidden_scope`, a target outside the grant `403 outside_grant`, an org or task the grant cannot see `404`. Browser-only routes answer `403 forbidden_scope`.',
    '- **`/api/auth/*`** (better-auth: sign-in, OAuth callbacks, sign-out) is for the browser cookie only; bearer and PAT credentials get `403` there. The exceptions are `POST /api/auth/device/code` and `POST /api/auth/device/token` (form or JSON bodies), the unauthenticated RFC 8628 device flow endpoints that `rooster login` uses. These routes are not part of this document.',
    '',
    '## Conventions',
    '',
    '- **JSON only**, UTF-8. Timestamps are ms epoch numbers, dates `YYYY-MM-DD` (floating, no timezone), times `HH:MM`. IDs are UUIDv7; clients may supply `id` on create.',
    '- **Errors** are RFC 9457 `application/problem+json` with a stable `code`; each operation lists its codes per status. `422 validation_failed` carries `errors: [{path, message}]`. Every response has an `X-Request-Id` header to quote in bug reports.',
    '- **Writes** accept `Idempotency-Key` (safe retries), `X-Rooster-Edit-Time` (per-field last write wins), `X-Rooster-Client-Id` and `X-Rooster-Client`.',
    '- **Ordering** is computed by the server: send `afterId` (the item directly above) and `beforeId` (the item directly below); never positions.',
    '- **Pagination** is cursor based: `?limit=…&cursor=…` answers `{items, nextCursor}`; `nextCursor` is null on the last page.',
    '- **Rate limits:** 600 requests per minute per user (`429 rate_limited` with `Retry-After`).',
    '- **Org IDs:** `{orgId}` accepts an org ID, its slug, or `personal`. Orgs you are not a member of are always `404`.',
    '- **Versioning:** v1 changes are additive only; breaking changes would get `/api/v2`.',
  ].join('\n');
}

type Json = Record<string, unknown>;
type Operation = Json & {
  tags?: string[];
  parameters?: Json[];
  responses?: Record<string, Json & { headers?: Json; content?: Record<string, Json> }>;
  security?: unknown[];
};

/**
 * The OpenAPI 3.1 document of the app, with what the route definitions cannot express on
 * their own: the quick start, servers, tags, security schemes, the shared request and
 * response headers, and the per-method pruning of problem codes.
 */
export function buildOpenApiDocument(
  app: Pick<OpenAPIHono<AppEnv>, 'getOpenAPI31Document'>,
  options: { version: string; baseUrl: string },
): Json {
  const doc = app.getOpenAPI31Document({
    openapi: '3.1.0',
    info: {
      title: 'rooster API',
      version: options.version,
      description: quickStart(options.baseUrl),
    },
    servers: [{ url: options.baseUrl, description: 'This instance' }],
  }) as unknown as Json & { paths: Record<string, Record<string, Operation>>; components?: Json };

  doc.components ??= {};
  const components = doc.components as Record<string, Json>;
  components.securitySchemes = { ...components.securitySchemes, ...SECURITY_SCHEMES };
  components.parameters = { ...components.parameters, ...REQUEST_HEADERS };
  components.headers = { ...components.headers, ...RESPONSE_HEADERS };
  doc.security = Object.keys(SECURITY_SCHEMES).map((name) => ({ [name]: [] }));

  const used = new Set<string>();
  for (const ops of Object.values(doc.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      for (const tag of op.tags ?? []) used.add(tag);
      const safe = SAFE_METHODS.has(method);
      // Every authenticated operation documents 401 (routes/common.ts `problems()`).
      const isPublic = op.responses?.['401'] === undefined;
      if (isPublic) op.security = [];
      for (const param of op.parameters ?? []) {
        const name = param.name as string;
        if (param.description === undefined && PARAMETER_DESCRIPTIONS[name] !== undefined) {
          param.description = PARAMETER_DESCRIPTIONS[name];
        }
      }
      if (!safe && !isPublic) {
        op.parameters = [
          ...(op.parameters ?? []),
          ...Object.keys(REQUEST_HEADERS).map((key) => ({
            $ref: `#/components/parameters/${key}`,
          })),
        ];
      }
      for (const [status, response] of Object.entries(op.responses ?? {})) {
        const problem = response.content?.['application/problem+json'] as
          | { examples?: Record<string, unknown> }
          | undefined;
        if (problem?.examples !== undefined) {
          for (const code of Object.keys(problem.examples)) {
            if (safe && UNSAFE_ONLY_CODES.has(code as ProblemCode)) delete problem.examples[code];
          }
          const codes = Object.keys(problem.examples).map((code) => `\`${code}\``);
          if (codes.length > 0) {
            response.description = `${response.description as string}. Codes: ${codes.join(', ')}.`;
          }
        }
        if (status === '429') {
          response.headers = {
            ...response.headers,
            'Retry-After': { $ref: '#/components/headers/RetryAfter' },
          };
        }
        if (!safe && !isPublic && status.startsWith('2')) {
          response.headers = {
            ...response.headers,
            'Idempotent-Replayed': { $ref: '#/components/headers/IdempotentReplayed' },
          };
        }
      }
    }
  }
  const known = new Set(OPENAPI_TAGS.map((t) => t.name));
  doc.tags = [
    ...OPENAPI_TAGS.filter((t) => used.has(t.name)),
    ...[...used].filter((name) => !known.has(name)).map((name) => ({ name })),
  ];
  return doc;
}
