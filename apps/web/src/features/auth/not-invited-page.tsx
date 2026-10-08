import { Link } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { buttonVariants } from '../../ui/button';
import { AuthLayout } from './auth-layout';

/** Why the server refused the sign-in (`/not-invited?reason=…`, FR-AUTH-2). */
export type NotInvitedReason =
  | 'not_invited'
  | 'account_disabled'
  | 'unverified_email'
  | 'account_link_blocked';

/** The text block of each specific reason (`not_invited` has its own layout). */
const variants = {
  account_disabled: 'disabled',
  unverified_email: 'unverified',
  account_link_blocked: 'linkBlocked',
} as const satisfies Record<Exclude<NotInvitedReason, 'not_invited'>, string>;

/**
 * The reason from the query string. Only known reasons map to their fixed text; anything else
 * (a typo, a reason a newer server added) shows the generic not-invited page.
 */
export function parseNotInvitedReason(value: unknown): NotInvitedReason {
  return typeof value === 'string' && Object.hasOwn(variants, value)
    ? (value as NotInvitedReason)
    : 'not_invited';
}

export interface NotInvitedPageProps {
  reason?: NotInvitedReason;
  /** The address the provider returned, when known. */
  email?: string | undefined;
  loginHref: string;
  embedded?: boolean | undefined;
}

/**
 * The friendly page for refused sign-ins: not invited, disabled, unverified email, or an
 * identity that may not attach to an existing account.
 */
export function NotInvitedPage({
  reason = 'not_invited',
  email,
  loginHref,
  embedded,
}: NotInvitedPageProps) {
  const { t } = useTranslation('auth');
  const variant = reason === 'not_invited' ? undefined : variants[reason];
  return (
    <AuthLayout embedded={embedded}>
      {variant === undefined ? (
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
        {variant === 'linkBlocked'
          ? t('notInvited.linkBlocked.action')
          : t('notInvited.tryAnother')}
      </Link>
    </AuthLayout>
  );
}
