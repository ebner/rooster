import { createFileRoute } from '@tanstack/react-router';
import { NotInvitedPage } from '../features/auth/not-invited-page';
import { paths } from '../features/shell/paths';

export const Route = createFileRoute('/not-invited')({
  validateSearch: (search: Record<string, unknown>): { email?: string } =>
    typeof search.email === 'string' ? { email: search.email } : {},
  component: NotInvitedRoute,
});

function NotInvitedRoute() {
  const { email } = Route.useSearch();
  return <NotInvitedPage email={email} loginHref={paths.login} />;
}
