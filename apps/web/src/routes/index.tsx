import { createFileRoute, redirect } from '@tanstack/react-router';

/** `/` opens My tasks of the personal org (02 §2). */
export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/o/$orgSlug/my', params: { orgSlug: 'personal' }, replace: true });
  },
});
