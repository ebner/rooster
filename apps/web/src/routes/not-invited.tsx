import { createFileRoute } from '@tanstack/react-router';
import {
  NotInvitedPage,
  type NotInvitedReason,
  parseNotInvitedReason,
} from '../features/auth/not-invited-page';
import { paths } from '../features/shell/paths';

export const Route = createFileRoute('/not-invited')({
  validateSearch: (search: Record<string, unknown>): { reason?: NotInvitedReason } => {
    const reason = parseNotInvitedReason(search.reason);
    return reason === 'not_invited' && search.reason !== 'not_invited' ? {} : { reason };
  },
  component: NotInvitedRoute,
});

function NotInvitedRoute() {
  const { reason } = Route.useSearch();
  return <NotInvitedPage reason={reason ?? 'not_invited'} loginHref={paths.login} />;
}
