import type { LinkedIdentity } from '@rooster/core/schemas';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from './http';
import { queryKeys } from './query-keys';
import type { MutationResult, QueryResult } from './types';

/**
 * Settings → Security → Linked identities (FR-SET-3, ADR 0041 §7): the sign-in identities of
 * the account. Online-only, browser session only (hard rule 4 exempts settings).
 */

/** `GET /me/identities`. */
export function useLinkedIdentities(): QueryResult<LinkedIdentity[]> {
  return useQuery({
    queryKey: queryKeys.identities,
    queryFn: async () => (await unwrap(api.GET('/api/v1/me/identities'))) as LinkedIdentity[],
  });
}

/** `DELETE /me/identities/:id`; `409 last_identity` for the only one left. */
export function useUnlinkIdentity(): MutationResult<{ id: string }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      await unwrap(api.DELETE('/api/v1/me/identities/{id}', { params: { path: { id } } }));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.identities }),
  });
}
