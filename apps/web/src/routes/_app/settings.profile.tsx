import { createFileRoute } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useChangeLocale, useMe, useUpdateProfile } from '../../data';
import { InstallAppSection } from '../../features/pwa/install-app-section';
import { ProfilePage } from '../../features/settings/profile-page';
import { toast } from '../../ui/toast';

export const Route = createFileRoute('/_app/settings/profile')({
  component: ProfileRoute,
});

function ProfileRoute() {
  const { t } = useTranslation('settings');
  const me = useMe();
  const update = useUpdateProfile();
  const changeLocale = useChangeLocale();
  if (!me.data) return null;
  const failed = () => toast({ message: t('error.saveFailed'), tone: 'danger' });
  return (
    <div className="flex flex-col gap-12">
      <ProfilePage
        user={me.data.user}
        onChange={(patch) =>
          update
            .mutateAsync(patch)
            .then(() => toast({ message: t('profile.saved'), durationMs: 2500 }))
            .catch(failed)
        }
        onLocaleChange={(locale) => changeLocale.mutateAsync(locale).catch(failed)}
      />
      {/* 02 §13.5: Settings → Install app. */}
      <InstallAppSection />
    </div>
  );
}
