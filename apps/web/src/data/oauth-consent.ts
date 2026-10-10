import type { Schemas } from '@rooster/api-client';
import type {
  OAuthConsentDecision,
  OAuthConsentRequest,
  OAuthConsentResult,
} from '@rooster/core/schemas';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError } from './errors';
import { api, unwrap } from './http';
import { queryKeys } from './query-keys';
import { useRefetchWhenSessionClears } from './session-bound';
import type { MutationResult, QueryResult } from './types';

/**
 * The OAuth consent screen (11 §3.1, ADR 0041/0042): rooster's routes around better-auth's
 * provider consent, so the decision carries scopes, constraints and the expiry. Session only.
 */

/**
 * `GET /oauth/consent?oauth_query=…`: who is asking for what. Not retried and never refetched:
 * the signed query is single-use and short-lived, so a second answer can't be better. Except
 * after a session change (sign-out, another account; ADR 0051): its `decisionNonce` belongs to
 * the session it was shown to, so the request is fetched again rather than answered with it.
 */
export function useOAuthConsentRequest(
  oauthQuery: string | undefined,
): QueryResult<OAuthConsentRequest> {
  useRefetchWhenSessionClears(queryKeys.oauthConsent(oauthQuery ?? ''));
  return useQuery({
    queryKey: queryKeys.oauthConsent(oauthQuery ?? ''),
    queryFn: async () =>
      (await unwrap(
        api.GET('/api/v1/oauth/consent', {
          params: { query: { oauth_query: oauthQuery as string } },
        }),
      )) as OAuthConsentRequest,
    enabled: Boolean(oauthQuery),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

/** `POST /oauth/consent`: Allow or Deny; the result is where the browser goes next. */
export function useOAuthConsentDecision(): MutationResult<
  OAuthConsentDecision,
  OAuthConsentResult
> {
  return useMutation({
    mutationFn: async (body: OAuthConsentDecision) =>
      (await unwrap(
        api.POST('/api/v1/oauth/consent', { body: body as Schemas['OAuthConsentDecision'] }),
      )) as OAuthConsentResult,
  });
}

export type ConsentErrorKind = 'invalid' | 'failed' | 'nothingApproved';

/** `422`: the decision approves none of what the app asked for (Allow with nothing). */
export const NOTHING_APPROVED = 'nothing_approved';

/**
 * An expired, tampered or already answered request (`4xx`) can't be retried from here: the
 * user starts again in the app. Approving nothing is fixable on the screen. Anything else
 * (network, `5xx`) may work on a second try.
 */
export function consentErrorKind(error: unknown): ConsentErrorKind {
  if (!(error instanceof ApiError)) return 'failed';
  if (error.code === NOTHING_APPROVED) return 'nothingApproved';
  if (error.status === 401 || error.status === 403 || error.status === 429) return 'failed';
  return error.status >= 400 && error.status < 500 ? 'invalid' : 'failed';
}
