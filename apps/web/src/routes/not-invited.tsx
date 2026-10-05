import { createFileRoute } from '@tanstack/react-router';
import { NotInvitedPage, type NotInvitedReason } from '../features/auth/not-invited-page';
import { paths } from '../features/shell/paths';

const reasons: Record<string, NotInvitedReason> = {
  not_invited: 'not_invited',
  account_disabled: 'account_disabled',
  unverified_email: 'unverified_email',
};

export const Route = createFileRoute('/not-invited')({
  validateSearch: (search: Record<string, unknown>): { reason?: NotInvitedReason } => {
    const reason = typeof search.reason === 'string' ? reasons[search.reason] : undefined;
    return reason ? { reason } : {};
  },
  component: NotInvitedRoute,
});

function NotInvitedRoute() {
  const { reason } = Route.useSearch();
  return <NotInvitedPage reason={reason ?? 'not_invited'} loginHref={paths.login} />;
}
