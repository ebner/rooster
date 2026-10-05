import { createFileRoute, redirect } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { meQueryOptions, useAuthProviders, useSignIn } from '../data';
import { type LoginError, LoginPage } from '../features/auth/login-page';
import { safeRedirectPath } from '../lib/safe-redirect';
import { toast } from '../ui/toast';

interface LoginSearch {
  error?: LoginError;
  redirect?: string;
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
    return { ...(error ? { error } : {}), ...(target ? { redirect: target } : {}) };
  },
  // Already signed in: continue to the app.
  beforeLoad: async ({ context, search }) => {
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
  const { error, redirect: target } = Route.useSearch();
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
          await signIn.mutateAsync({ providerId, ...(target ? { callbackUrl: target } : {}) });
        } catch {
          toast({ message: t('login.error.failed.title'), tone: 'danger' });
          setPendingProviderId(null);
        }
      }}
    />
  );
}
