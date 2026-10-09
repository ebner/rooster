import { createFileRoute } from '@tanstack/react-router';

/** Everyone's tasks (02 §11, FR-VIEW-2): rendered by the `_tasks` layout, like My tasks. */
export const Route = createFileRoute('/_app/o/$orgSlug/_tasks/everyone')({
  component: () => null,
});
