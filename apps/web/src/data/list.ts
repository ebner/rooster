import { uuidv7 } from '@rooster/core/ids';
import type { ListState } from '@rooster/core/reducers';
import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import { httpTransport } from './pipeline/http-transport';
import { ListPipeline, myListKey } from './pipeline/pipeline';
import type { ListTransport } from './pipeline/transport';
import type { QueryResult } from './types';

export { type DroppedOp, ListPipeline, myListKey } from './pipeline/pipeline';
export type { ListTransport } from './pipeline/transport';

/**
 * X-Rooster-Client-Id (06 §1): one per tab, new on every page load. The SSE hub echoes it as
 * `origin`, and a tab skips refetching changes it made itself. A per-profile id (shared by all
 * tabs) made every tab skip changes another tab sent, so a tab that missed the cross-tab
 * confirmation (e.g. frozen in the background on Android) never caught up.
 */
const clientId = uuidv7();

export function getClientId(): string {
  return clientId;
}

/**
 * The transport behind the pipeline. Production always uses `httpTransport`; the dev-only
 * fixture route provides an in-memory server here.
 */
export const ListTransportContext = createContext<ListTransport>(httpTransport);

const pipelines = new WeakMap<QueryClient, Map<ListTransport, ListPipeline>>();

/** One pipeline per query client and transport (the app has exactly one). */
export function getListPipeline(queryClient: QueryClient, transport: ListTransport): ListPipeline {
  let byTransport = pipelines.get(queryClient);
  if (!byTransport) {
    byTransport = new Map();
    pipelines.set(queryClient, byTransport);
  }
  let pipeline = byTransport.get(transport);
  if (!pipeline) {
    pipeline = new ListPipeline({ transport, queryClient, clientId: getClientId() });
    byTransport.set(transport, pipeline);
  }
  return pipeline;
}

/**
 * Installs a preconfigured pipeline (P4: the HTTP one with the IndexedDB outbox, leader
 * election and the tab channel; see `data/sync/engine.ts`) before anything asks for it.
 */
export function registerListPipeline(
  queryClient: QueryClient,
  transport: ListTransport,
  pipeline: ListPipeline,
): void {
  let byTransport = pipelines.get(queryClient);
  if (!byTransport) {
    byTransport = new Map();
    pipelines.set(queryClient, byTransport);
  }
  byTransport.set(transport, pipeline);
}

export function useListPipeline(): ListPipeline {
  return getListPipeline(useQueryClient(), useContext(ListTransportContext));
}

/**
 * `['my-list', orgId]` (04 §5.1): the normalized My tasks state with every pending
 * optimistic op applied. All writes go through `useListPipeline().enqueue` (hard rule 4).
 */
export function useMyList(orgId: string | undefined): QueryResult<ListState> {
  const pipeline = useListPipeline();
  return useQuery({
    queryKey: myListKey(orgId ?? ''),
    queryFn: () => pipeline.fetch(orgId as string),
    enabled: Boolean(orgId),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * Whether `['my-list', orgId]` has data or failed, without subscribing to the data itself:
 * the list's frame re-renders on status changes only.
 */
export function useMyListStatus(orgId: string): { ready: boolean; error: Error | null } {
  const pipeline = useListPipeline();
  const query = useQuery({
    queryKey: myListKey(orgId),
    queryFn: () => pipeline.fetch(orgId),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    select: () => true,
  });
  return { ready: query.data === true, error: query.error };
}

/**
 * A slice of `['my-list', orgId]`. Results are structurally shared, so a component re-renders
 * only when its slice changed, not on every list op (AC-2.12 with the pane open).
 */
export function useMyListSelect<T>(orgId: string, select: (state: ListState) => T): QueryResult<T> {
  const pipeline = useListPipeline();
  return useQuery({
    queryKey: myListKey(orgId),
    queryFn: () => pipeline.fetch(orgId),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    select,
  });
}
