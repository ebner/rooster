import { createFileRoute } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useChangeLocale, useMe, useUpdateProfile } from '../../data';
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
  );
}
