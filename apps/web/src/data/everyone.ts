import type { Task } from '@rooster/core/schemas';
import { type QueryClient, useQuery } from '@tanstack/react-query';
import { useListPipeline } from './list';
import type { ListPipeline } from './pipeline/pipeline';
import { queryKeys } from './query-keys';
import type { QueryResult } from './types';

/**
 * The filter part of the Everyone cache key. Filters (tag, due, members) run on the client over
 * the org's open tasks (`selectEveryone`), so changing them is instant and works offline; one
 * cache per org is enough.
 */
export const everyoneFilters = 'open';

export const everyoneKey = (orgId: string) => queryKeys.everyone(orgId, everyoneFilters);

/** `PAGE_LIMIT_MAX` of `@rooster/core/schemas` (not imported: zod stays off this route). */
const pageLimit = 200;

/**
 * Every page of `GET /orgs/:orgId/tasks?view=everyone` (open rows of every assignee), with the
 * org's queued ops replayed on top, as the cache holds them.
 */
export async function fetchEveryone(
  pipeline: ListPipeline,
  orgId: string,
  signal?: AbortSignal,
): Promise<Task[]> {
  const items: Task[] = [];
  let cursor: string | undefined;
  do {
    const page = await pipeline.transport.fetchTasks(
      orgId,
      { view: 'everyone', completed: 'false', limit: pageLimit, ...(cursor ? { cursor } : {}) },
      signal,
    );
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return pipeline.withPendingTasks(orgId, items);
}

function everyoneQuery(pipeline: ListPipeline, orgId: string) {
  return {
    queryKey: everyoneKey(orgId),
    queryFn: ({ signal }: { signal: AbortSignal }) => fetchEveryone(pipeline, orgId, signal),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  } as const;
}

/**
 * `['everyone', orgId, 'open']` (02 §11): a flat `Task[]` of the org's open rows, every
 * assignee. The pipeline applies queued ops to it optimistically; SSE invalidates
 * `['everyone', orgId]`. Shared orgs only (a personal org answers 409).
 */
export function useEveryone(
  orgId: string | undefined,
  enabled = true,
): QueryResult<readonly Task[]> {
  const pipeline = useListPipeline();
  return useQuery({
    ...everyoneQuery(pipeline, orgId ?? ''),
    enabled: Boolean(orgId) && enabled,
  });
}

/**
 * Whether the Everyone cache has data or failed, without subscribing to the data: the list's
 * frame re-renders on status changes only (as `useMyListStatus`).
 */
export function useEveryoneStatus(
  orgId: string,
  enabled: boolean,
): { ready: boolean; error: Error | null } {
  const pipeline = useListPipeline();
  const query = useQuery({ ...everyoneQuery(pipeline, orgId), enabled, select: () => true });
  return { ready: !enabled || query.data === true, error: enabled ? query.error : null };
}

/** Seeds the cache (the kitchen sink and tests run without a server). */
export function seedEveryone(
  queryClient: QueryClient,
  orgId: string,
  tasks: readonly Task[],
): void {
  queryClient.setQueryData(everyoneKey(orgId), tasks);
}
