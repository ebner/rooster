import type { ListOp } from '@rooster/core/reducers';
import type { MyList } from '@rooster/core/schemas';
import { api, toApiError } from '../http';
import { type ListTransport, opHeaders, parseRetryAfter, RateLimitedError } from './transport';

interface FetchResult {
  data?: unknown;
  error?: unknown;
  response: Response;
}

/**
 * Zod infers optional fields as `T | undefined`; the generated OpenAPI types do not. JSON drops
 * `undefined`, so the payloads are the same on the wire.
 */
type Wire<T> = T extends readonly (infer U)[]
  ? Wire<U>[]
  : T extends object
    ? { [K in keyof T]: Wire<Exclude<T[K], undefined>> }
    : T;
const wire = <T>(payload: T) => payload as Wire<T>;

async function settle(request: Promise<FetchResult>): Promise<unknown> {
  const { data, error, response } = await request;
  if (response.status === 429) {
    throw new RateLimitedError(parseRetryAfter(response.headers.get('Retry-After'), Date.now()));
  }
  if (!response.ok) throw toApiError(error, response.status);
  return response.status === 204 ? undefined : data;
}

/** One request per op (06 §2.3–2.4), with the idempotency and edit-time headers. */
function request(op: ListOp, orgId: string): Promise<FetchResult> {
  const headers = opHeaders(op);
  const id = op.entityId;
  switch (op.kind) {
    case 'task.create':
      return api.POST('/api/v1/orgs/{orgId}/tasks', {
        params: { path: { orgId } },
        body: wire(op.payload),
        headers,
      });
    case 'task.patch':
      return api.PATCH('/api/v1/tasks/{id}', {
        params: { path: { id } },
        body: wire(op.payload),
        headers,
      });
    case 'task.complete':
      return api.POST('/api/v1/tasks/{id}/complete', {
        params: { path: { id } },
        body: wire(op.payload),
        headers,
      });
    case 'task.delete':
      return api.DELETE('/api/v1/tasks/{id}', { params: { path: { id } }, headers });
    case 'task.restore':
      return api.POST('/api/v1/tasks/{id}/restore', { params: { path: { id } }, headers });
    case 'task.move':
      return api.POST('/api/v1/tasks/{id}/move', {
        params: { path: { id } },
        body: wire(op.payload),
        headers,
      });
    case 'task.bulk':
      return api.POST('/api/v1/tasks/bulk', { body: wire(op.payload), headers });
    case 'group.create':
      return api.POST('/api/v1/orgs/{orgId}/groups', {
        params: { path: { orgId } },
        body: wire(op.payload),
        headers,
      });
    case 'group.patch':
      return api.PATCH('/api/v1/groups/{id}', {
        params: { path: { id } },
        body: wire(op.payload),
        headers,
      });
    case 'group.move':
      return api.POST('/api/v1/groups/{id}/move', {
        params: { path: { id } },
        body: wire(op.payload),
        headers,
      });
    case 'group.delete':
      return api.DELETE('/api/v1/groups/{id}', {
        params: { path: { id } },
        body: wire(op.payload),
        headers,
      });
    case 'group.restore':
      return api.POST('/api/v1/groups/{id}/restore', { params: { path: { id } }, headers });
  }
}

/** The production transport over `@rooster/api-client`. */
export const httpTransport: ListTransport = {
  fetchMyList: async (orgId) =>
    (await settle(
      api.GET('/api/v1/orgs/{orgId}/my-list', { params: { path: { orgId } } }),
    )) as MyList,
  send: (op, orgId) => settle(request(op, orgId)),
};
