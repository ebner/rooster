import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useChangeLocale, useMe, useUpdateProfile } from '../../data';
import {
  avatarFileProblem,
  isUploadedAvatar,
  useRemoveAvatar,
  useUploadAvatar,
} from '../../data/avatar';
import { ApiError } from '../../data/errors';
import { useOnline } from '../../features/attachments/use-online';
import { InstallAppSection } from '../../features/pwa/install-app-section';
import { type AvatarError, AvatarField } from '../../features/settings/avatar-field';
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
        avatar={<ProfileAvatar userId={me.data.user.id} image={me.data.user.image} />}
      />
      {/* 02 §13.5: Settings → Install app. */}
      <InstallAppSection />
    </div>
  );
}

/** FR-SET-1 (P10): `PUT`/`DELETE /me/avatar`; the new picture shows wherever `/me` is read. */
function ProfileAvatar({ userId, image }: { userId: string; image: string | null }) {
  const { t } = useTranslation('settings');
  const upload = useUploadAvatar();
  const remove = useRemoveAvatar();
  const online = useOnline();
  const [pending, setPending] = useState<'upload' | 'remove' | null>(null);
  const [error, setError] = useState<AvatarError | null>(null);
  return (
    <AvatarField
      uploaded={isUploadedAvatar(image, userId)}
      pending={pending}
      error={error}
      online={online}
      onUpload={async (file) => {
        const problem = avatarFileProblem(file);
        if (problem) {
          setError(problem);
          return;
        }
        setError(null);
        setPending('upload');
        try {
          await upload.mutateAsync(file);
          toast({ message: t('profile.avatar.uploaded'), durationMs: 2500 });
        } catch (cause) {
          const status = cause instanceof ApiError ? cause.status : 0;
          setError(status === 413 ? 'size' : status === 415 ? 'type' : 'failed');
        } finally {
          setPending(null);
        }
      }}
      onRemove={async () => {
        setError(null);
        setPending('remove');
        try {
          await remove.mutateAsync();
          toast({ message: t('profile.avatar.removed') });
        } catch {
          setError('failed');
        } finally {
          setPending(null);
        }
      }}
    />
  );
}
