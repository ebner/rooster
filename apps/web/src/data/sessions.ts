import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from './http';
import { toSession } from './mappers';
import { queryKeys } from './query-keys';
import type { MutationResult, QueryResult, UserSession } from './types';

/** `GET /me/sessions`. */
export function useSessions(): QueryResult<UserSession[]> {
  return useQuery({
    queryKey: queryKeys.sessions,
    queryFn: async () => (await unwrap(api.GET('/api/v1/me/sessions'))).map(toSession),
  });
}

/** `DELETE /me/sessions/:id`: that browser is signed out on its next request (AC-1.7). */
export function useRevokeSession(): MutationResult<{ sessionId: string }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId }: { sessionId: string }) => {
      await unwrap(api.DELETE('/api/v1/me/sessions/{id}', { params: { path: { id: sessionId } } }));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
  });
}
