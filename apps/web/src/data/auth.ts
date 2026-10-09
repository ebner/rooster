import { useMutation, useQuery } from '@tanstack/react-query';
import { safeRedirectPath } from '../lib/safe-redirect';
import { ApiError } from './errors';
import { api, unwrap } from './http';
import { queryKeys } from './query-keys';
import { clearLocalData } from './sync/engine';
import type { AuthProvider, MutationResult, QueryResult } from './types';

/** 10 §4: the better-auth client (~8 KB gzip) is only needed to sign in or out. */
const loadAuthClient = () => import('./auth-client').then((m) => m.authClient);

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
  /**
   * An app's authorization that sent the browser to sign in (rooster's OAuth server, ADR
   * 0041): the provider's signed query. better-auth verifies it and, once signed in, carries
   * on with that authorization (the consent screen) instead of `callbackUrl`.
   */
  oauthQuery?: string;
}

/**
 * Starts the OAuth/OIDC flow and leaves the page. Rejected sign-ins come back on
 * `/not-invited?reason=…`, other provider errors on `/login?error=…`.
 */
export async function startSignIn({
  providerId,
  callbackUrl,
  oauthQuery,
}: SignInVariables): Promise<void> {
  const callbackURL = safeRedirectPath(callbackUrl) ?? '/';
  const errorCallbackURL = '/login';
  const authClient = await loadAuthClient();
  const result = await authClient.signIn.social({
    provider: providerId,
    callbackURL,
    errorCallbackURL,
    // The field better-auth's OAuth provider reads from any sign-in body (its client plugin
    // adds it the same way); not in the social sign-in's own types.
    ...(oauthQuery ? ({ oauth_query: oauthQuery } as Record<string, string>) : {}),
  });
  if (result.error) {
    throw new ApiError(result.error.code ?? 'sign_in_failed', result.error.status ?? 500);
  }
}

export function useSignIn(): MutationResult<SignInVariables> {
  return useMutation({ mutationFn: startSignIn });
}

/** How long sign-out waits for push cleanup (an unreachable server must not block it). */
const pushCleanupMs = 3000;

/**
 * Push off for this browser before the session ends (P1: on a shared browser the next person
 * would otherwise get this user's notifications). The DELETE needs the session, so this runs
 * first; it never throws and never holds sign-out up for long. The push module is lazy.
 */
export async function forgetPushBeforeSignOut(
  load: () => Promise<{ forgetPushOnSignOut: () => Promise<void> }> = () => import('./push'),
  timeoutMs = pushCleanupMs,
): Promise<void> {
  const cleanup = load()
    .then((push) => push.forgetPushOnSignOut())
    .catch(() => undefined);
  await Promise.race([cleanup, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
}

/**
 * Ends the session and forgets this user's local copies (push on this browser, the persisted
 * cache and the outbox, in every tab; 04 §6.1). Callers then load `/login` afresh (a full page load).
 */
export function useSignOut(): MutationResult<void> {
  return useMutation({
    mutationFn: async () => {
      // Leaves the identity provider's session alone (no RP-initiated logout): signing
      // out of rooster should not sign the user out of their company SSO.
      const authClient = await loadAuthClient();
      await forgetPushBeforeSignOut();
      const result = await authClient.signOut({ disableRedirect: true });
      if (result.error) throw new ApiError('sign_out_failed', result.error.status ?? 500);
      await clearLocalData();
    },
  });
}
