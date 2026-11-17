import { createFileRoute } from '@tanstack/react-router';

/** All organisations → Today (ADR 0073 A): rendered by the `all` layout. */
export const Route = createFileRoute('/_app/all/today')({
  component: () => null,
});
