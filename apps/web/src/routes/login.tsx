import { createFileRoute, redirect } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { meQueryOptions, useAuthProviders, useSignIn } from '../data';
import { signedOAuthQuery } from '../features/access/client-display';
import { type LoginError, LoginPage } from '../features/auth/login-page';
import { safeRedirectPath } from '../lib/safe-redirect';
import { toast } from '../ui/toast';

interface LoginSearch {
  error?: LoginError;
  redirect?: string;
  /** An app's authorization waiting for sign-in (better-auth's `loginPage` redirect). */
  oauth_query?: string;
}

/** The signed query is a few hundred bytes; anything far larger is not one. */
const MAX_OAUTH_QUERY = 8192;

/**
 * better-auth's OAuth provider sends a signed-out user here with its signed authorization
 * query (`?client_id=…&ba_param=…&sig=…`). The router re-serialises the search on the first
 * render, which would break the signature, so it is read from the raw URL once and kept as one
 * opaque `oauth_query`. The server verifies it; nothing here trusts it.
 */
function loginOAuthQuery(search: Record<string, unknown>): string | undefined {
  let query: string | undefined;
  if (typeof search.oauth_query === 'string') query = search.oauth_query;
  else if (globalThis.location?.pathname === '/login') {
    query = signedOAuthQuery(globalThis.location.search);
  }
  return query && query.length <= MAX_OAUTH_QUERY ? query : undefined;
}

/** better-auth error codes (`/login?error=…`) → the banners the page knows. */
function toLoginError(code: unknown): LoginError | undefined {
  if (typeof code !== 'string' || code === '') return undefined;
  if (code === 'not_invited') return 'not_invited';
  if (code === 'account_disabled' || code === 'disabled') return 'disabled';
  if (code === 'invite_invalid') return 'invite_invalid';
  return 'failed';
}

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): LoginSearch => {
    const error = toLoginError(search.error);
    const target = safeRedirectPath(search.redirect);
    const oauthQuery = loginOAuthQuery(search);
    return {
      ...(error ? { error } : {}),
      ...(target ? { redirect: target } : {}),
      ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
    };
  },
  // Already signed in: continue to the app. Not for an app's authorization (it may ask to
  // sign in afresh, `prompt=login`): the page stays and signing in carries the authorization on.
  beforeLoad: async ({ context, search }) => {
    if (search.oauth_query) return;
    const signedIn = await context.queryClient
      .fetchQuery(meQueryOptions)
      .then(() => true)
      .catch(() => false);
    if (signedIn) throw redirect({ href: safeRedirectPath(search.redirect) ?? '/', replace: true });
  },
  component: LoginRoute,
});

function LoginRoute() {
  const { t } = useTranslation('auth');
  const { error, redirect: target, oauth_query: oauthQuery } = Route.useSearch();
  const providers = useAuthProviders();
  const signIn = useSignIn();
  const [pendingProviderId, setPendingProviderId] = useState<string | null>(null);

  return (
    <LoginPage
      providers={providers.data ?? []}
      error={error}
      pendingProviderId={pendingProviderId}
      onSignIn={async (providerId) => {
        setPendingProviderId(providerId);
        try {
          // Leaves the page for the provider; the promise only settles on failure.
          await signIn.mutateAsync({
            providerId,
            ...(target ? { callbackUrl: target } : {}),
            ...(oauthQuery ? { oauthQuery } : {}),
          });
        } catch {
          toast({ message: t('login.error.failed.title'), tone: 'danger' });
          setPendingProviderId(null);
        }
      }}
    />
  );
}
