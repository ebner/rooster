import { commentIdOf, commentTaskId, feedItems } from '@rooster/core/activity';
import type { ActivityItem, ActivityPage } from '@rooster/core/schemas';
import { type InfiniteData, useInfiniteQuery } from '@tanstack/react-query';
import { useMemo, useSyncExternalStore } from 'react';
import { useListPipeline } from './list';
import { queryKeys } from './query-keys';

/**
 * `['activity', taskId]` (04 §5.1, ADR 0028): `pages[0]` is the newest page (fetched without a
 * cursor), older pages follow, and every page's items are oldest first. The pipeline appends
 * optimistic comments to the end of `pages[0].items`.
 */
export type ActivityPages = InfiniteData<ActivityPage, string | null>;

export const activityPageSize = 30;

export interface ActivityResult {
  /** Oldest first. */
  items: ActivityItem[] | undefined;
  isPending: boolean;
  error: Error | null;
  /** Older entries exist ("Load earlier"). */
  hasEarlier: boolean;
  isLoadingEarlier: boolean;
  loadEarlier: () => void;
}

/**
 * `GET /tasks/:id/activity` (06 §2.6): comments and activity, interleaved. Always the whole
 * feed (`filter=all`): "Comments only" filters it locally, so one cache serves both views and
 * the pipeline's optimistic comments land in it.
 */
export function useActivity(taskId: string): ActivityResult {
  const pipeline = useListPipeline();
  const query = useInfiniteQuery({
    queryKey: queryKeys.activity(taskId),
    // Queued comment ops are replayed over every fetched page, so a refetch never hides them.
    queryFn: async ({ pageParam, signal }): Promise<ActivityPage> =>
      pipeline.withPendingActivity(
        taskId,
        await pipeline.transport.fetchActivity(
          taskId,
          { limit: activityPageSize, ...(pageParam ? { cursor: pageParam } : {}) },
          signal,
        ),
        pageParam === null,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    staleTime: 10_000,
  });
  // Reading order: oldest first, newest last (06 §2.6).
  const items = useMemo(() => (query.data ? feedItems(query.data) : undefined), [query.data]);
  return {
    items,
    isPending: query.isPending,
    error: query.error,
    hasEarlier: query.hasNextPage,
    isLoadingEarlier: query.isFetchingNextPage,
    loadEarlier: () => void query.fetchNextPage(),
  };
}

/**
 * Comments of `taskId` with an op still in the outbox: the feed shows them as "Sending…"
 * until the server confirms (04 §6.2).
 */
export function usePendingComments(orgId: string, taskId: string): ReadonlySet<string> {
  const pipeline = useListPipeline();
  const key = useSyncExternalStore(pipeline.subscribe, () =>
    pipeline
      .pendingOps(orgId)
      .filter((op) => commentTaskId(op) === taskId)
      .map(commentIdOf)
      .filter((id): id is string => id !== null)
      .join(),
  );
  return useMemo(() => new Set(key ? key.split(',') : []), [key]);
}
