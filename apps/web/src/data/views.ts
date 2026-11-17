import { uuidv7 } from '@rooster/core/ids';
import type {
  SavedView,
  SavedViewCreate,
  SavedViewMove,
  SavedViewPatch,
} from '@rooster/core/schemas';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from './http';
import { queryKeys } from './query-keys';
import type { MutationResult, QueryResult } from './types';

/**
 * Phase 13 (ADR 0073 B): an org's views, in the viewer's own order. Managing views is
 * online-only, like org settings (hard rule 4 covers tasks, groups, tags and placements): plain
 * mutations, then `['views', orgId]` is refetched (SSE refetches it on other members' changes).
 * A view's rows are another cache (`['view-tasks', viewId, …]`, kept optimistic by the list
 * pipeline).
 */
export function useViews(
  orgId: string | undefined,
  options: { archived?: boolean } = {},
): QueryResult<readonly SavedView[]> {
  const archived = options.archived === true;
  const query = useQuery({
    queryKey: queryKeys.views(orgId ?? '', archived),
    queryFn: async () =>
      (await unwrap(
        api.GET('/api/v1/orgs/{orgId}/views', {
          params: {
            path: { orgId: orgId as string },
            query: archived ? { archived: 'true' } : {},
          },
        }),
      )) as SavedView[],
    enabled: Boolean(orgId),
    staleTime: 30_000,
  });
  return { data: query.data, isPending: query.isPending, error: query.error };
}

/** Drops `undefined` members: the API types are exact about optional properties. */
function present<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}

function useViewMutation<V, R>(orgId: string, run: (vars: V) => Promise<R>): MutationResult<V, R> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ['views', orgId] });
    },
  });
}

/** Creates a view (at the end of the order); `id` defaults to a new UUIDv7. */
export function useCreateView(orgId: string) {
  return useViewMutation(
    orgId,
    async (input: SavedViewCreate) =>
      (await unwrap(
        api.POST('/api/v1/orgs/{orgId}/views', {
          params: { path: { orgId } },
          body: present({ ...input, id: input.id ?? uuidv7() }),
        }),
      )) as SavedView,
  );
}

export function useUpdateView(orgId: string) {
  return useViewMutation(orgId, async ({ id, patch }: { id: string; patch: SavedViewPatch }) => {
    const view = (await unwrap(
      api.PATCH('/api/v1/views/{id}', { params: { path: { id } }, body: present(patch) }),
    )) as SavedView;
    return view;
  });
}

export function useDeleteView(orgId: string) {
  return useViewMutation(orgId, (id: string) =>
    unwrap(api.DELETE('/api/v1/views/{id}', { params: { path: { id } } })),
  );
}

export function useMoveView(orgId: string) {
  return useViewMutation(
    orgId,
    async ({ id, intent }: { id: string; intent: SavedViewMove }) =>
      (await unwrap(
        api.POST('/api/v1/views/{id}/move', { params: { path: { id } }, body: present(intent) }),
      )) as SavedView,
  );
}

/** Archive (true) or restore (false). */
export function useArchiveView(orgId: string) {
  return useViewMutation(
    orgId,
    async ({ id, archived }: { id: string; archived: boolean }) =>
      (await unwrap(
        archived
          ? api.POST('/api/v1/views/{id}/archive', { params: { path: { id } } })
          : api.POST('/api/v1/views/{id}/restore', { params: { path: { id } } }),
      )) as SavedView,
  );
}
