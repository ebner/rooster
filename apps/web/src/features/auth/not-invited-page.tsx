import { Link } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { buttonVariants } from '../../ui/button';
import { AuthLayout } from './auth-layout';

export interface NotInvitedPageProps {
  /** The address the provider returned, when known. */
  email?: string | undefined;
  loginHref: string;
  embedded?: boolean | undefined;
}

/** FR-AUTH-2: the friendly page for verified emails that are not allowlisted or invited. */
export function NotInvitedPage({ email, loginHref, embedded }: NotInvitedPageProps) {
  const { t } = useTranslation('auth');
  return (
    <AuthLayout embedded={embedded}>
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
      <Link href={loginHref} className={buttonVariants({ variant: 'secondary', size: 'lg' })}>
        {t('notInvited.tryAnother')}
      </Link>
    </AuthLayout>
  );
}
