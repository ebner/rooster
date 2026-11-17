import { matchesViewFilters, type SavedViewContext } from '@rooster/core/saved-views';
import type { SavedViewQuery, Task } from '@rooster/core/schemas';
import { type QueryClient, useQuery } from '@tanstack/react-query';
import { useListPipeline } from './list';
import type { ListPipeline } from './pipeline/pipeline';
import type { ViewTasksData } from './pipeline/view-tasks-ops';
import { queryKeys } from './query-keys';
import type { QueryResult } from './types';

export { viewTasksRootKey } from './pipeline/pipeline';
export { isViewTasksData, type ViewTasksData } from './pipeline/view-tasks-ops';

/**
 * Phase 13 (ADR 0073 B): a view's rows, `['view-tasks', viewId, 'open' | 'all']`. Like
 * Everyone's tasks the cache has no confirmed base: the query function replays the org's queued
 * ops over each fetch (`withPendingViewTasks`), and the pipeline applies every new op to it at
 * once, so edits in the view (and anywhere else in the org) show before the server answers.
 * The screen filters and groups the rows with `@rooster/core/saved-views` against the view's
 * current query, so a task that stops matching leaves at once, and a narrower query applies
 * before the refetch.
 */
export const viewTasksKey = (viewId: string, completed: boolean) =>
  queryKeys.viewTasks(viewId, completed);

export async function fetchViewTasks(
  pipeline: ListPipeline,
  orgId: string,
  viewId: string,
  completed: boolean,
  signal?: AbortSignal,
): Promise<ViewTasksData> {
  const fetch = pipeline.transport.fetchViewTasks;
  if (!fetch) throw new Error('This transport has no views');
  const page = await fetch(viewId, { completed: completed ? 'true' : 'false' }, signal);
  return {
    orgId,
    // The ancestors of matching subtasks come along for breadcrumbs (they are no rows:
    // `selectSavedView` re-applies the query).
    items: pipeline.withPendingViewTasks(orgId, page.items),
    counts: page.counts,
    doneAtFetch: page.items.filter((t) => t.completedAt !== null).map((t) => t.id),
  };
}

function viewTasksQuery(pipeline: ListPipeline, orgId: string, viewId: string, completed: boolean) {
  return {
    queryKey: viewTasksKey(viewId, completed),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      fetchViewTasks(pipeline, orgId, viewId, completed, signal),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    // "Show completed" switches to the other cache of the same view: its rows stay meanwhile.
    placeholderData: <T>(previous: T | undefined, query?: { queryKey: readonly unknown[] }) =>
      query?.queryKey[1] === viewId ? previous : undefined,
  } as const;
}

/** A view's rows (open only, or with the completed ones). */
export function useViewTasks(
  orgId: string | undefined,
  viewId: string | undefined,
  completed: boolean,
): QueryResult<ViewTasksData> {
  const pipeline = useListPipeline();
  return useQuery({
    ...viewTasksQuery(pipeline, orgId ?? '', viewId ?? '', completed),
    enabled: Boolean(orgId && viewId),
  });
}

/**
 * The rows' status without subscribing to them (the frame re-renders on status changes only,
 * as `useMyListStatus`).
 */
export function useViewTasksStatus(
  orgId: string,
  viewId: string | undefined,
  completed: boolean,
): { ready: boolean; error: Error | null } {
  const pipeline = useListPipeline();
  const query = useQuery({
    ...viewTasksQuery(pipeline, orgId, viewId ?? '', completed),
    enabled: Boolean(viewId),
    select: () => true,
  });
  return { ready: query.data === true, error: query.error };
}

/** Seeds the cache (the kitchen sink and tests run without a server). */
export function seedViewTasks(
  queryClient: QueryClient,
  viewId: string,
  completed: boolean,
  data: ViewTasksData,
): void {
  queryClient.setQueryData(viewTasksKey(viewId, completed), data);
}

/**
 * "7 open · 12 done" (B3): the server's counts, plus what changed here since the fetch: matches
 * created, deleted, completed or reopened (optimistic ops, the pipeline keeps them in the
 * cache). The extra parents sent for breadcrumbs don't match, or were counted already.
 */
export function viewCounts(
  data: ViewTasksData,
  query: SavedViewQuery,
  ctx: SavedViewContext,
): { open: number; done: number } {
  const wasDone = new Set(data.doneAtFetch ?? []);
  let open = 0;
  let doneDelta = 0;
  for (const task of data.items as readonly Task[]) {
    if (!matchesViewFilters(task, query, ctx)) continue;
    const done = task.completedAt !== null;
    if (!done) open++;
    if (done && !wasDone.has(task.id)) doneDelta++;
    else if (!done && wasDone.has(task.id)) doneDelta--;
  }
  return { open, done: Math.max(0, data.counts.done + doneDelta) };
}
