import { Link } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { buttonVariants } from '../../ui/button';
import { AuthLayout } from './auth-layout';

/** Why the server refused the sign-in (`/not-invited?reason=…`, FR-AUTH-2). */
export type NotInvitedReason = 'not_invited' | 'account_disabled' | 'unverified_email';

export interface NotInvitedPageProps {
  reason?: NotInvitedReason;
  /** The address the provider returned, when known. */
  email?: string | undefined;
  loginHref: string;
  embedded?: boolean | undefined;
}

/** The friendly page for refused sign-ins: not invited, disabled, or unverified email. */
export function NotInvitedPage({
  reason = 'not_invited',
  email,
  loginHref,
  embedded,
}: NotInvitedPageProps) {
  const { t } = useTranslation('auth');
  const variant = reason === 'account_disabled' ? 'disabled' : 'unverified';
  return (
    <AuthLayout embedded={embedded}>
      {reason === 'not_invited' ? (
        <>
          <div className="flex flex-col gap-2">
            <h1 className="text-xl">{t('notInvited.title')}</h1>
            <p className="text-sm text-text-secondary">
              {email ? t('notInvited.bodyWithEmail', { email }) : t('notInvited.body')}
            </p>
          </div>
          <ul className="flex flex-col gap-2 text-start text-sm text-text-secondary">
            <li>{t('notInvited.askLink')}</li>
            <li>{t('notInvited.askAdmin')}</li>
          </ul>
        </>
      ) : (
        <div className="flex flex-col gap-2">
          <h1 className="text-xl">{t(`notInvited.${variant}.title`)}</h1>
          <p className="text-sm text-text-secondary">{t(`notInvited.${variant}.body`)}</p>
        </div>
      )}
      <Link href={loginHref} className={buttonVariants({ variant: 'secondary', size: 'lg' })}>
        {t('notInvited.tryAnother')}
      </Link>
    </AuthLayout>
  );
}
