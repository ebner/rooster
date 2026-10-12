import type { AdminSystem } from '@rooster/core/schemas';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from './http';
import { queryKeys } from './query-keys';
import type { MutationResult, QueryResult } from './types';

export interface AdminSystemResult extends QueryResult<AdminSystem> {
  /** A refetch is in flight (the refresh button spins). */
  isFetching: boolean;
  /** When the shown status was fetched (ms epoch; 0 before the first). */
  updatedAt: number;
  refetch: () => void;
}

/**
 * `GET /admin/system` (08 §9, ADR 0052 §7), instance admins only. Online-only: never persisted
 * (the `admin` root is not in `persistedRoots`), always fetched fresh when the page opens.
 */
export function useAdminSystem(): AdminSystemResult {
  const query = useQuery({
    queryKey: queryKeys.adminSystem,
    queryFn: () => unwrap(api.GET('/api/v1/admin/system')),
    staleTime: 0,
  });
  return {
    data: query.data,
    isPending: query.isPending,
    error: query.error,
    isFetching: query.isFetching,
    updatedAt: query.dataUpdatedAt,
    refetch: () => void query.refetch(),
  };
}

/** `POST /admin/search/reindex`: what the rebuild indexed, and how long it took. */
export interface ReindexResult {
  indexed: number;
  durationMs: number;
}

/**
 * `POST /admin/search/reindex` (ADR 0013): rebuilds the full-text index from the tasks, the
 * manual repair the server otherwise runs at boot. Online-only, like all of admin.
 */
export function useReindexSearch(): MutationResult<void, ReindexResult> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(api.POST('/api/v1/admin/search/reindex')),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['search'] }),
  });
}

/**
 * `POST /admin/mail/test` (ADR 0059): a test email to the signed-in admin's own address. It
 * resolves once the SMTP server accepted it; `502 mail_failed` carries its code and status.
 */
export function useSendTestMail(): MutationResult<void, { to: string; sentAt: number }> {
  return useMutation({
    mutationFn: () => unwrap(api.POST('/api/v1/admin/mail/test')),
  });
}
