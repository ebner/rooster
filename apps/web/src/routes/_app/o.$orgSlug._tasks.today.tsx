import { createFileRoute } from '@tanstack/react-router';

/** Today (02 §10): rendered by the `_tasks` layout, like My tasks. */
export const Route = createFileRoute('/_app/o/$orgSlug/_tasks/today')({
  component: () => null,
});
