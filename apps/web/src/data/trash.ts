import type { Task, TrashPage } from '@rooster/core/schemas';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from './http';
import { myListKey } from './list';
import { queryKeys } from './query-keys';
import type { MutationResult } from './types';

const trashPageSize = 50;

export interface TrashResult {
  /** Newest deleted first, every loaded page. */
  items: Task[] | undefined;
  isPending: boolean;
  error: Error | null;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
}

/** `GET /orgs/:orgId/trash` (06 §2.4), paged. Trash is org-wide (ADR 0005). Online only. */
export function useTrash(orgId: string | undefined): TrashResult {
  const query = useInfiniteQuery({
    queryKey: queryKeys.trash(orgId ?? ''),
    queryFn: ({ pageParam }): Promise<TrashPage> =>
      unwrap(
        api.GET('/api/v1/orgs/{orgId}/trash', {
          params: {
            path: { orgId: orgId as string },
            query: { limit: trashPageSize, ...(pageParam ? { cursor: pageParam } : {}) },
          },
        }),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: Boolean(orgId),
    staleTime: 10_000,
  });
  return {
    items: query.data?.pages.flatMap((page) => page.items),
    isPending: query.isPending,
    error: query.error,
    hasMore: query.hasNextPage,
    isLoadingMore: query.isFetchingNextPage,
    loadMore: () => void query.fetchNextPage(),
  };
}

export interface TrashTaskRef {
  orgId: string;
  taskId: string;
}

/**
 * `POST /tasks/:id/restore` from Trash. Not a list-pipeline op: a task in Trash is usually not
 * in the local `deletedTasks` (deleted in another session, or long ago), where the optimistic
 * `restoreTask` reducer is a no-op. The list is refetched instead (ADR 0012).
 */
export function useRestoreFromTrash(): MutationResult<TrashTaskRef> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ taskId }: TrashTaskRef) => {
      await unwrap(api.POST('/api/v1/tasks/{id}/restore', { params: { path: { id: taskId } } }));
    },
    onSuccess: (_data, { orgId }) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.trash(orgId) }),
        queryClient.invalidateQueries({ queryKey: myListKey(orgId) }),
      ]),
  });
}

/** `DELETE /tasks/:id/permanent`: only for tasks in Trash; cannot be undone. */
export function useDeletePermanently(): MutationResult<TrashTaskRef> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ taskId }: TrashTaskRef) => {
      await unwrap(
        api.DELETE('/api/v1/tasks/{id}/permanent', { params: { path: { id: taskId } } }),
      );
    },
    onSuccess: (_data, { orgId }) =>
      queryClient.invalidateQueries({ queryKey: queryKeys.trash(orgId) }),
  });
}
