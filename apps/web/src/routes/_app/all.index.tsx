import { createFileRoute, redirect } from '@tanstack/react-router';
import { paths } from '../../features/shell/paths';

/** `/all` opens All organisations → Today. */
export const Route = createFileRoute('/_app/all/')({
  beforeLoad: () => {
    throw redirect({ href: paths.allView('today'), replace: true });
  },
});
