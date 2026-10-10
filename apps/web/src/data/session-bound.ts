import { type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { onSessionDataCleared } from './session-events';

/**
 * Fetches `queryKey` again whenever the session's data clears (sign-out, a lost session,
 * another account; ADR 0051). For requests whose answer is bound to the session they were shown
 * in, such as a consent request's `decisionNonce`: never answer them with the old one.
 */
export function useRefetchWhenSessionClears(queryKey: QueryKey): void {
  const queryClient = useQueryClient();
  const serialized = JSON.stringify(queryKey);
  // Compared by value: callers build the key afresh on every render.
  useEffect(
    () =>
      onSessionDataCleared(() => {
        void queryClient.resetQueries({ queryKey });
      }),
    [queryClient, serialized],
  );
}
