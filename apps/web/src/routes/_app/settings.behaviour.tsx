import { DEFAULT_PREFS } from '@rooster/core/limits';
import { createFileRoute } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useMe, useUpdateProfile } from '../../data';
import { BehaviourPage, type BehaviourSettings } from '../../features/settings/behaviour-page';
import { toast } from '../../ui/toast';

export const Route = createFileRoute('/_app/settings/behaviour')({
  component: BehaviourRoute,
});

function BehaviourRoute() {
  const { t } = useTranslation('settings');
  const me = useMe();
  const update = useUpdateProfile();
  if (!me.data) return null;
  // Defaults under the stored prefs: a server older than a pref leaves it out.
  const prefs = { ...DEFAULT_PREFS, ...me.data.prefs };
  return (
    <BehaviourPage
      orgs={me.data.orgs}
      value={{
        parseTitleDates: prefs.parseTitleDates,
        completeHideMs: prefs.completeHideMs,
        swipeLeft: prefs.swipeLeft,
        swipeRight: prefs.swipeRight,
        defaultOrgId: prefs.defaultOrgId,
        startPage: prefs.startPage,
      }}
      onChange={(patch: Partial<BehaviourSettings>) =>
        update
          // `PATCH /me` takes partial prefs (FR-SET-2); online-only, and the cached `/me` is
          // written only while the session lasts (`useUpdateProfile`, ADR 0051).
          .mutateAsync({ prefs: patch })
          .then(() => toast({ message: t('profile.saved'), durationMs: 2500 }))
          .catch(() => toast({ message: t('error.saveFailed'), tone: 'danger' }))
      }
    />
  );
}
