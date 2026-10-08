import type { ListState } from '@rooster/core/reducers';
import type { SearchHit } from '@rooster/core/schemas';
import { keepPreviousData, type QueryClient, useQuery } from '@tanstack/react-query';
import { api, unwrap } from './http';
import { queryKeys } from './query-keys';
import type { QueryResult } from './types';

/** 06 §2.8: ranked best first; `limit` defaults to the server's (50). */
export async function fetchSearch(
  q: string,
  orgId: string | null,
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  return unwrap(
    api.GET('/api/v1/search', {
      params: { query: { q, ...(orgId ? { orgId } : {}) } },
      ...(signal ? { signal } : {}),
    }),
  );
}

export interface SearchParams {
  q: string;
  /** Null: every org of the viewer. */
  orgId: string | null;
  enabled: boolean;
}

/**
 * `GET /search` for the palette (02 §12). The caller debounces `q`; earlier results stay on
 * screen while the next query loads. Never retried: offline the palette filters the cache.
 */
export function useSearch({ q, orgId, enabled }: SearchParams): QueryResult<SearchHit[]> & {
  isFetching: boolean;
} {
  const query = useQuery({
    queryKey: queryKeys.search(orgId ?? 'all', q),
    queryFn: ({ signal }) => fetchSearch(q, orgId, signal),
    enabled: enabled && q.trim() !== '',
    staleTime: 15_000,
    gcTime: 60_000,
    retry: false,
    placeholderData: keepPreviousData,
    networkMode: 'always',
  });
  return {
    data: query.data,
    isPending: query.isPending,
    error: query.error,
    isFetching: query.isFetching,
  };
}

/**
 * The cached `['my-list', orgId]` of the viewer's current orgs (the confirmed base plus queued
 * ops), for offline search. Lists of orgs missing from `/me` (membership revoked) never show.
 */
export function cachedListStates(
  queryClient: QueryClient,
  orgIds: ReadonlySet<string>,
): ListState[] {
  return queryClient
    .getQueriesData<ListState>({ queryKey: ['my-list'] })
    .flatMap(([key, state]) =>
      state && typeof key[1] === 'string' && orgIds.has(key[1]) ? [state] : [],
    );
}
