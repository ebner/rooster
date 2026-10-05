import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthProviders, useMe, useSignIn } from '../data';
import { isLoginError, type LoginError, LoginPage } from '../features/auth/login-page';
import { safeRedirectPath } from '../lib/safe-redirect';
import { toast } from '../ui/toast';

interface LoginSearch {
  error?: LoginError;
  redirect?: string;
}

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): LoginSearch => {
    const redirect = safeRedirectPath(search.redirect);
    return {
      ...(isLoginError(search.error) ? { error: search.error } : {}),
      ...(redirect ? { redirect } : {}),
    };
  },
  component: LoginRoute,
});

function LoginRoute() {
  const { t } = useTranslation('auth');
  const { error, redirect } = Route.useSearch();
  const navigate = useNavigate();
  const me = useMe();
  const providers = useAuthProviders();
  const signIn = useSignIn();
  const [pendingProviderId, setPendingProviderId] = useState<string | null>(null);

  const signedIn = Boolean(me.data);
  // Already signed in (or the fixture sign-in finished): continue to the app.
  useEffect(() => {
    if (signedIn) void navigate({ href: safeRedirectPath(redirect) ?? '/', replace: true });
  }, [signedIn]);

  return (
    <LoginPage
      providers={providers.data ?? []}
      error={error}
      pendingProviderId={pendingProviderId}
      onSignIn={async (providerId) => {
        setPendingProviderId(providerId);
        try {
          const callbackUrl = safeRedirectPath(redirect);
          await signIn.mutateAsync({ providerId, ...(callbackUrl ? { callbackUrl } : {}) });
        } catch {
          toast({ message: t('login.error.failed.title'), tone: 'danger' });
        } finally {
          setPendingProviderId(null);
        }
      }}
    />
  );
}
