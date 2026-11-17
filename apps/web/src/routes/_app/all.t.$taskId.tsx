import { createFileRoute } from '@tanstack/react-router';

/** `/all/t/:taskId` (02 §10.1): the pane over the last All view, rendered by the `all` layout. */
export const Route = createFileRoute('/_app/all/t/$taskId')({
  component: () => null,
});
