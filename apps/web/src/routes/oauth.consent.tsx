import { OAUTH_QUERY_MAX } from '@rooster/core/limits';
import { isLocale } from '@rooster/i18n/core';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, meQueryOptions, queryKeys, useDisplayPrefs, useMe } from '../data';
import { confirmGrantOrgs, useGrantOrgsState } from '../data/grants';
import {
  consentErrorKind,
  useOAuthConsentDecision,
  useOAuthConsentRequest,
} from '../data/oauth-consent';
import { isSessionClosed } from '../data/session-events';
import { clientName, externalRedirect, signedOAuthQuery } from '../features/access/client-display';
import { ConsentPage, type ConsentPageState } from '../features/access/consent-page';
import { setLocale } from '../lib/i18n';
import { safeRedirectPath } from '../lib/safe-redirect';
import { toast } from '../ui/toast';

interface ConsentSearch {
  oauth_query?: string;
}

/**
 * `/oauth/consent` (11 §3.1, ADR 0041/0042): where better-auth's OAuth provider sends the
 * browser (`consentPage`) to ask the user. Signed in, outside the app frame, like `/device`.
 *
 * The provider appends its signed parameters (`?client_id=…&ba_param=…&sig=…`). The router
 * re-serialises the search on the first render, which would break the signature, so they are
 * read from the raw URL once and kept as one opaque `oauth_query` (also accepted as given).
 */
export const Route = createFileRoute('/oauth/consent')({
  validateSearch: (search: Record<string, unknown>): ConsentSearch => {
    let query: string | undefined;
    if (typeof search.oauth_query === 'string') query = search.oauth_query;
    else if (globalThis.location?.pathname === '/oauth/consent') {
      query = signedOAuthQuery(globalThis.location.search);
    }
    return query && query.length <= OAUTH_QUERY_MAX ? { oauth_query: query } : {};
  },
  beforeLoad: async ({ context, search }) => {
    try {
      await context.queryClient.ensureQueryData({ ...meQueryOptions, revalidateIfStale: true });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        const back = search.oauth_query
          ? `/oauth/consent?${new URLSearchParams({ oauth_query: search.oauth_query })}`
          : '/oauth/consent';
        const target = safeRedirectPath(back);
        throw redirect({ to: '/login', search: target ? { redirect: target } : {} });
      }
      throw error;
    }
  },
  component: ConsentRoute,
});

type Leaving = Extract<ConsentPageState, { kind: 'leaving' }>;

function ConsentRoute() {
  const { t, i18n } = useTranslation('auth');
  const { oauth_query: oauthQuery } = Route.useSearch();
  const me = useMe();
  const queryClient = useQueryClient();
  const prefs = useDisplayPrefs();
  const { orgs, ready } = useGrantOrgsState();
  const request = useOAuthConsentRequest(oauthQuery);
  const decide = useOAuthConsentDecision();
  // Outside the app frame, so follow the profile's language here too (04 §8).
  const storedLocale = me.data?.user.locale;
  useEffect(() => {
    if (isLocale(storedLocale) && storedLocale !== i18n.language) void setLocale(storedLocale);
  }, [storedLocale, i18n.language]);
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  // A decision the server refused as expired or already answered: nothing left to retry here.
  const [lateInvalid, setLateInvalid] = useState(false);
  const [notice, setNotice] = useState<'nothingApproved' | null>(null);

  const state: ConsentPageState = leaving
    ? leaving
    : !oauthQuery || lateInvalid
      ? { kind: 'invalid' }
      : request.error
        ? { kind: consentErrorKind(request.error) === 'failed' ? 'failed' : 'invalid' }
        : request.data && ready
          ? { kind: 'request', request: request.data }
          : { kind: 'loading' };

  const answer = async (accept: boolean, body: Parameters<typeof decide.mutateAsync>[0]) => {
    if (!request.data) return;
    setNotice(null);
    try {
      const result = await decide.mutateAsync(body);
      // The one navigation to another origin: the client's registered redirect URI, as the
      // server resolved it for this very request (with `code` and `iss`, or the denial). It
      // can't go through `safeRedirectPath`, which allows same-origin paths only;
      // `externalRedirect` still refuses anything but http(s) to the target shown.
      const target = externalRedirect(result.redirectTo, request.data.redirectUri);
      if (!target) throw new ApiError('invalid_redirect', 502);
      setLeaving({
        kind: 'leaving',
        accepted: accept,
        clientName: clientName(request.data.client),
      });
      // A decision that finishes after another account took over this browser must not be
      // delivered (the code would be that account's; ADR 0051).
      if (isSessionClosed()) return;
      window.location.assign(target);
    } catch (error) {
      const kind = consentErrorKind(error);
      if (kind === 'nothingApproved') setNotice('nothingApproved');
      else if (kind === 'invalid') setLateInvalid(true);
      else
        toast({
          message: t(accept ? 'consent.allowFailed' : 'consent.denyFailed'),
          tone: 'danger',
        });
    }
  };

  return (
    <ConsentPage
      key={state.kind}
      state={state}
      account={me.data?.user.email ?? ''}
      orgs={orgs}
      prefs={prefs}
      now={Date.now()}
      homeHref="/"
      onRetry={() =>
        void queryClient.resetQueries({ queryKey: queryKeys.oauthConsent(oauthQuery ?? '') })
      }
      notice={notice}
      confirmOrgs={() => confirmGrantOrgs(orgs.map((org) => org.id))}
      onAllow={(decision) => answer(true, decision)}
      onDeny={async () => {
        if (!request.data) return;
        await answer(false, {
          accept: false,
          oauthQuery: request.data.oauthQuery,
          decisionNonce: request.data.decisionNonce,
        });
      }}
    />
  );
}
