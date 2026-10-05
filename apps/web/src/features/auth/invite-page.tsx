import { LogIn } from 'lucide-react';
import { Link } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import type { AuthProvider, InvitePreview } from '../../data/types';
import { Avatar } from '../../ui/avatar';
import { Banner } from '../../ui/banner';
import { Button, buttonVariants } from '../../ui/button';
import { AuthLayout } from './auth-layout';

export interface InvitePageProps {
  preview: InvitePreview;
  signedIn: boolean;
  providers: readonly AuthProvider[];
  /** Signed out: store the invite and start sign-in with this provider (04 §4.4). */
  onAcceptAndSignIn: (providerId: string) => void;
  /** Signed in: join directly (`POST /invites/:token/accept`). */
  onJoin: () => void;
  isPending?: boolean;
  homeHref: string;
  embedded?: boolean | undefined;
}

/** `/invite/:token`: who invited you to which org, then accept (FR-ORG-3). */
export function InvitePage({
  preview,
  signedIn,
  providers,
  onAcceptAndSignIn,
  onJoin,
  isPending = false,
  homeHref,
  embedded,
}: InvitePageProps) {
  const { t } = useTranslation('auth');
  const { org, status } = preview;

  if (status !== 'valid' || !org) {
    return (
      <AuthLayout embedded={embedded}>
        <div className="flex flex-col gap-2">
          <h1 className="text-xl">
            {t(`invite.invalid.${status === 'valid' ? 'notFound' : status}.title`)}
          </h1>
          <p className="text-sm text-text-secondary">
            {t(`invite.invalid.${status === 'valid' ? 'notFound' : status}.body`, {
              org: org?.name ?? '',
            })}
          </p>
        </div>
        <Link href={homeHref} className={buttonVariants({ variant: 'secondary', size: 'lg' })}>
          {t('invite.goHome')}
        </Link>
      </AuthLayout>
    );
  }

  const role = t(`invite.role.${preview.role ?? 'member'}`);
  return (
    <AuthLayout embedded={embedded}>
      <div className="flex flex-col items-center gap-4">
        <Avatar
          id={org.id}
          name={org.name}
          emoji={org.avatarEmoji}
          color={org.color}
          shape="square"
          size={40}
          decorative
        />
        <div className="flex flex-col gap-2">
          <h1 className="text-xl">{t('invite.title', { org: org.name })}</h1>
          <p className="text-sm text-text-secondary">
            {preview.inviterName
              ? t('invite.byInviter', { inviter: preview.inviterName, org: org.name, role })
              : t('invite.noInviter', { org: org.name, role })}
          </p>
        </div>
      </div>
      {signedIn ? (
        <Button
          variant="primary"
          size="lg"
          className="w-full"
          isLoading={isPending}
          onPress={onJoin}
        >
          {t('invite.join', { org: org.name })}
        </Button>
      ) : providers.length === 0 ? (
        <Banner tone="warning" title={t('login.noProviders.title')}>
          {t('login.noProviders.body')}
        </Banner>
      ) : (
        <div className="flex flex-col gap-2">
          {providers.map((provider, index) => (
            <Button
              key={provider.id}
              variant={index === 0 ? 'primary' : 'secondary'}
              size="lg"
              icon={LogIn}
              className="w-full"
              isLoading={isPending}
              onPress={() => onAcceptAndSignIn(provider.id)}
            >
              {providers.length === 1
                ? t('invite.acceptAndSignIn')
                : t('invite.acceptWith', { provider: provider.name })}
            </Button>
          ))}
        </div>
      )}
    </AuthLayout>
  );
}
