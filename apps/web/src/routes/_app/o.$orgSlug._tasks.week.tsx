import { createFileRoute } from '@tanstack/react-router';

/** Next 7 days (02 §10): rendered by the `_tasks` layout, like My tasks. */
export const Route = createFileRoute('/_app/o/$orgSlug/_tasks/week')({
  component: () => null,
});
