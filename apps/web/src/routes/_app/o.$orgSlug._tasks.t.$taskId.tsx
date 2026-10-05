import { createFileRoute } from '@tanstack/react-router';

/** `/o/:orgSlug/t/:taskId` (02 §2): the pane over My tasks, rendered by the `_tasks` layout. */
export const Route = createFileRoute('/_app/o/$orgSlug/_tasks/t/$taskId')({
  component: () => null,
});
