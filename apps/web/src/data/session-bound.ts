import { type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { ApiError } from './errors';
import { onSessionDataCleared, sessionScope } from './session-events';

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

/**
 * Runs a request whose answer holds a secret shown once (a new token, a calendar feed URL, an
 * invite link) for the session it started in: an answer that arrives after that session ended
 * is dropped (`aborted`), never shown on the page or kept in the mutation cache (ADR 0051).
 */
export async function inSession<T>(run: () => Promise<T>): Promise<T> {
  const scope = sessionScope();
  const result = await run();
  if (scope.stale()) throw new ApiError('aborted', 0);
  return result;
}
