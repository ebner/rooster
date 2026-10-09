import { createFileRoute } from '@tanstack/react-router';

/** The notification inbox (FR-NOT-1): every org's notifications in one list. */
export const Route = createFileRoute('/_app/inbox')({
  component: () => null,
});
