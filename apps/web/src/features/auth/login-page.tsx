import { LogIn } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AuthProvider } from '../../data/types';
import { Banner } from '../../ui/banner';
import { Button } from '../../ui/button';
import { AuthLayout } from './auth-layout';

/** Why the user landed back on the login page (`/login?error=…`). */
export const loginErrors = ['not_invited', 'disabled', 'invite_invalid', 'failed'] as const;
export type LoginError = (typeof loginErrors)[number];

export function isLoginError(value: unknown): value is LoginError {
  return typeof value === 'string' && (loginErrors as readonly string[]).includes(value);
}

export interface LoginPageProps {
  providers: readonly AuthProvider[];
  error?: LoginError | undefined;
  onSignIn: (providerId: string) => void;
  /** The provider whose button shows a spinner while the redirect starts. */
  pendingProviderId?: string | null | undefined;
  embedded?: boolean | undefined;
}

/** WP 1.4: one button per configured provider (`GET /meta`), no passwords (FR-AUTH-1). */
export function LoginPage({
  providers,
  error,
  onSignIn,
  pendingProviderId,
  embedded,
}: LoginPageProps) {
  const { t } = useTranslation('auth');
  return (
    <AuthLayout embedded={embedded}>
      <div className="flex flex-col gap-2">
        <h1 className="text-xl">{t('login.title')}</h1>
        <p className="text-sm text-text-secondary">{t('login.subtitle')}</p>
      </div>
      {error && (
        <Banner tone="danger" role="alert" title={t(`login.error.${error}.title`)}>
          {t(`login.error.${error}.body`)}
        </Banner>
      )}
      {providers.length > 0 ? (
        <div className="flex flex-col gap-2">
          {providers.map((provider) => (
            <Button
              key={provider.id}
              size="lg"
              icon={LogIn}
              className="w-full"
              isLoading={pendingProviderId === provider.id}
              isDisabled={Boolean(pendingProviderId) && pendingProviderId !== provider.id}
              onPress={() => onSignIn(provider.id)}
            >
              {t('login.continueWith', { provider: provider.name })}
            </Button>
          ))}
        </div>
      ) : (
        <Banner tone="warning" title={t('login.noProviders.title')}>
          {t('login.noProviders.body')}
        </Banner>
      )}
      <p className="text-xs text-text-muted">{t('login.inviteOnly')}</p>
    </AuthLayout>
  );
}
