import { createFileRoute } from '@tanstack/react-router';

/** Settings → Notifications (FR-NOT-4): the in-app column of the preference matrix (P6). */
export const Route = createFileRoute('/_app/settings/notifications')({
  component: () => null,
});
