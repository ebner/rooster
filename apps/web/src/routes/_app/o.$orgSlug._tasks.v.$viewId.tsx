import { createFileRoute } from '@tanstack/react-router';

/**
 * A view of the org (ADR 0073 B, 02 §10.2), or "+ New view" at `/v/new`: rendered by the
 * `_tasks` layout like every list, so the pane (`/t/:taskId`) opens over it.
 */
export const Route = createFileRoute('/_app/o/$orgSlug/_tasks/v/$viewId')({
  component: () => null,
});
