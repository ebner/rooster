import { createFileRoute } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useNotificationPrefs, useUpdateNotificationPrefs } from '../../data/notifications';
import { NotificationsPage } from '../../features/settings/notifications-page';
import { toast } from '../../ui/toast';

/** Settings → Notifications (FR-NOT-4): the in-app column of the preference matrix (P6). */
export const Route = createFileRoute('/_app/settings/notifications')({
  component: NotificationsRoute,
});

function NotificationsRoute() {
  const { t } = useTranslation('settings');
  const prefs = useNotificationPrefs();
  const update = useUpdateNotificationPrefs();
  return (
    <NotificationsPage
      prefs={prefs.data}
      error={prefs.error}
      onChange={(type, enabled) =>
        update
          .mutateAsync([{ type, channel: 'inapp', enabled }])
          .then(() => toast({ message: t('profile.saved'), durationMs: 2500 }))
          .catch(() => toast({ message: t('error.saveFailed'), tone: 'danger' }))
      }
    />
  );
}
