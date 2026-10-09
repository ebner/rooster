import type { ListOp } from '@rooster/core/reducers';
import type { MyList, Tag, TaskDetail } from '@rooster/core/schemas';
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
function request(op: ListOp, orgId: string, signal?: AbortSignal): Promise<FetchResult> {
  const headers = opHeaders(op);
  const init = signal ? { headers, signal } : { headers };
  const id = op.entityId;
  switch (op.kind) {
    case 'task.create':
      return api.POST('/api/v1/orgs/{orgId}/tasks', {
        params: { path: { orgId } },
        body: wire(op.payload),
        ...init,
      });
    case 'task.patch':
      return api.PATCH('/api/v1/tasks/{id}', {
        params: { path: { id } },
        body: wire(op.payload),
        ...init,
      });
    case 'task.complete':
      return api.POST('/api/v1/tasks/{id}/complete', {
        params: { path: { id } },
        body: wire(op.payload),
        ...init,
      });
    case 'task.delete':
      return api.DELETE('/api/v1/tasks/{id}', { params: { path: { id } }, ...init });
    case 'task.restore':
      return api.POST('/api/v1/tasks/{id}/restore', { params: { path: { id } }, ...init });
    case 'task.move':
      return api.POST('/api/v1/tasks/{id}/move', {
        params: { path: { id } },
        body: wire(op.payload),
        ...init,
      });
    case 'task.bulk':
      return api.POST('/api/v1/tasks/bulk', { body: wire(op.payload), ...init });
    case 'task.reorder':
      return api.POST('/api/v1/tasks/{id}/reorder', {
        params: { path: { id } },
        body: wire(op.payload),
        ...init,
      });
    case 'task.duplicate':
      return api.POST('/api/v1/tasks/{id}/duplicate', {
        params: { path: { id } },
        body: wire(op.payload),
        ...init,
      });
    case 'task.expanded':
      return op.payload.expanded
        ? api.PUT('/api/v1/tasks/{id}/expanded', { params: { path: { id } }, ...init })
        : api.DELETE('/api/v1/tasks/{id}/expanded', { params: { path: { id } }, ...init });
    case 'task.addTag':
    case 'task.removeTag': {
      const params = { path: { id, tagId: op.payload.tagId } };
      return op.kind === 'task.addTag'
        ? api.PUT('/api/v1/tasks/{id}/tags/{tagId}', { params, ...init })
        : api.DELETE('/api/v1/tasks/{id}/tags/{tagId}', { params, ...init });
    }
    case 'tag.create':
      return api.POST('/api/v1/orgs/{orgId}/tags', {
        params: { path: { orgId } },
        body: wire(op.payload),
        ...init,
      });
    case 'group.create':
      return api.POST('/api/v1/orgs/{orgId}/groups', {
        params: { path: { orgId } },
        body: wire(op.payload),
        ...init,
      });
    case 'group.patch':
      return api.PATCH('/api/v1/groups/{id}', {
        params: { path: { id } },
        body: wire(op.payload),
        ...init,
      });
    case 'group.move':
      return api.POST('/api/v1/groups/{id}/move', {
        params: { path: { id } },
        body: wire(op.payload),
        ...init,
      });
    case 'group.delete':
      return api.DELETE('/api/v1/groups/{id}', {
        params: { path: { id } },
        body: wire(op.payload),
        ...init,
      });
    case 'group.restore':
      return api.POST('/api/v1/groups/{id}/restore', { params: { path: { id } }, ...init });
    case 'task.follow':
    case 'comment.create':
    case 'comment.patch':
    case 'comment.delete':
    case 'comment.restore':
      return Promise.reject(new Error(`${op.kind}: the P6 routes are not wired yet`));
  }
}

/** The production transport over `@rooster/api-client`. */
export const httpTransport: ListTransport = {
  fetchMyList: async (orgId) =>
    (await settle(
      api.GET('/api/v1/orgs/{orgId}/my-list', { params: { path: { orgId } } }),
    )) as MyList,
  fetchTask: async (id) =>
    (await settle(api.GET('/api/v1/tasks/{id}', { params: { path: { id } } }))) as TaskDetail,
  fetchTags: async (orgId) =>
    (await settle(api.GET('/api/v1/orgs/{orgId}/tags', { params: { path: { orgId } } }))) as Tag[],
  send: (op, orgId, signal) => settle(request(op, orgId, signal)),
};
