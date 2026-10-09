# @rooster/api-client

A typed client for the rooster REST API (`/api/v1`). The types are generated from the
server's OpenAPI document with `openapi-typescript`; requests go through `openapi-fetch`, so
paths, parameters, bodies and responses are all checked by TypeScript.

The interactive reference of a running instance is at `<your instance>/api/docs`, and the
document itself at `/api/v1/openapi.json`.

## Usage

```ts
import { createRoosterClient, isProblem, unwrap } from '@rooster/api-client';

const api = createRoosterClient({
  baseUrl: 'https://tasks.example.com',
  token: process.env.ROOSTER_TOKEN, // a personal access token, `rooster_pat_…`
  clientName: 'my-script/1.0.0',    // shown as "via" in task activity
});

// Throws a RoosterApiError for any non-2xx response.
const me = await unwrap(api.GET('/api/v1/me'));

const task = await unwrap(
  api.POST('/api/v1/orgs/{orgId}/tasks', {
    params: { path: { orgId: 'personal' } },
    body: { title: 'Pay invoice tomorrow >Prio', parse: true },
    headers: { 'Idempotency-Key': crypto.randomUUID() },
  }),
);

// Or handle errors yourself: `error` is the problem+json body.
const { data, error } = await api.GET('/api/v1/tasks/{id}', {
  params: { path: { id: task.id } },
});
if (isProblem(error)) console.error(error.code, error.detail);
```

## Options

| Option | Purpose |
|---|---|
| `baseUrl` | The instance origin, e.g. `https://tasks.example.com`. Paths include `/api/v1`. |
| `token` | `Authorization: Bearer <token>`: a PAT or a CLI device-flow session token. A string, or a (sync or async) function called before every request. Omit it in the browser: same-origin requests carry the session cookie. |
| `clientName` | `X-Rooster-Client`, e.g. `cli/1.2.0`. |
| `clientId` | `X-Rooster-Client-Id`, one per client instance (a tab or a process); echoed as `origin` in server-sent events. |
| `fetch` | A custom `fetch` implementation. |
| `headers` | Extra headers on every request. |

Any other `openapi-fetch` client option is passed through.

## Errors

Every error is an RFC 9457 problem document with a stable `code` (`Problem`):
`unauthenticated`, `forbidden_scope`, `outside_grant`, `not_found`, `validation_failed`
(with `errors: [{path, message}]`), `rate_limited` (see `Retry-After`) and so on.
`isProblem(value)` narrows an unknown value to `Problem`. `unwrap()` throws a
`RoosterApiError` with `status`, `code` (the problem's, or `http_<status>`) and `problem`.

## Development

- `pnpm gen:api` (repository root) re-emits `apps/server/openapi.json` and regenerates
  `src/schema.d.ts`. Never edit `schema.d.ts` by hand.
- `pnpm --filter @rooster/api-client build` builds `dist/` (ESM and bundled declarations),
  which `publishConfig.exports` points at. Inside the monorepo the package is consumed from
  `src/`.
