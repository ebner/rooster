import { useMutation, useQuery } from '@tanstack/react-query';
import { safeRedirectPath } from '../lib/safe-redirect';
import { authClient } from './auth-client';
import { ApiError } from './errors';
import { api, unwrap } from './http';
import { queryKeys } from './query-keys';
import type { AuthProvider, MutationResult, QueryResult } from './types';

/** `GET /meta` → the configured sign-in providers (login page). */
export function useAuthProviders(): QueryResult<AuthProvider[]> {
  return useQuery({
    queryKey: queryKeys.meta,
    queryFn: async () => (await unwrap(api.GET('/api/v1/meta'))).providers,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export interface SignInVariables {
  providerId: string;
  /** Where to land after the OAuth round trip; defaults to `/`. Untrusted input. */
  callbackUrl?: string;
}

/**
 * Starts the OAuth/OIDC flow and leaves the page. Rejected sign-ins come back on
 * `/not-invited?reason=…`, other provider errors on `/login?error=…`.
 */
export async function startSignIn({ providerId, callbackUrl }: SignInVariables): Promise<void> {
  const callbackURL = safeRedirectPath(callbackUrl) ?? '/';
  const errorCallbackURL = '/login';
  const result = await authClient.signIn.social({
    provider: providerId,
    callbackURL,
    errorCallbackURL,
  });
  if (result.error) {
    throw new ApiError(result.error.code ?? 'sign_in_failed', result.error.status ?? 500);
  }
}

export function useSignIn(): MutationResult<SignInVariables> {
  return useMutation({ mutationFn: startSignIn });
}

/**
 * Ends the session. Callers then load `/login` afresh (a full page load), which also
 * drops every cached response of this user.
 */
export function useSignOut(): MutationResult<void> {
  return useMutation({
    mutationFn: async () => {
      // Leaves the identity provider's session alone (no RP-initiated logout): signing
      // out of rooster should not sign the user out of their company SSO.
      const result = await authClient.signOut({ disableRedirect: true });
      if (result.error) throw new ApiError('sign_out_failed', result.error.status ?? 500);
    },
  });
}
