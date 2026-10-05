import { DEFAULT_PREFS } from '@rooster/core/schemas';
import { createFileRoute } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useMe, useUpdateProfile } from '../../data';
import { BehaviourPage, type SwipeSettings } from '../../features/settings/behaviour-page';
import { toast } from '../../ui/toast';

export const Route = createFileRoute('/_app/settings/behaviour')({
  component: BehaviourRoute,
});

function BehaviourRoute() {
  const { t } = useTranslation('settings');
  const me = useMe();
  const update = useUpdateProfile();
  if (!me.data) return null;
  const prefs = me.data.prefs ?? DEFAULT_PREFS;
  return (
    <BehaviourPage
      value={{ swipeLeft: prefs.swipeLeft, swipeRight: prefs.swipeRight }}
      onChange={(patch: Partial<SwipeSettings>) =>
        update
          // `PATCH /me` takes partial prefs (FR-SET-2).
          .mutateAsync({ prefs: patch })
          .then(() => toast({ message: t('profile.saved'), durationMs: 2500 }))
          .catch(() => toast({ message: t('error.saveFailed'), tone: 'danger' }))
      }
    />
  );
}
