import { createFileRoute } from '@tanstack/react-router';

/** My tasks: rendered by the `_tasks` layout (the list stays mounted when the pane opens). */
export const Route = createFileRoute('/_app/o/$orgSlug/_tasks/my')({
  component: () => null,
});
