import { ImageUp, Trash2 } from 'lucide-react';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Banner } from '../../ui/banner';
import { Button } from '../../ui/button';

export type AvatarError = 'type' | 'size' | 'failed';

export interface AvatarFieldProps {
  /** The picture is one uploaded to rooster (not the sign-in provider's). */
  uploaded: boolean;
  pending: 'upload' | 'remove' | null;
  error: AvatarError | null;
  online: boolean;
  onUpload: (file: File) => void;
  onRemove: () => void;
}

/** The raster types `PUT /me/avatar` takes (SVG never counts as an image, ADR 0049 §3.2). */
const accept = 'image/png,image/jpeg,image/gif,image/webp,image/avif';

const errorKeys = {
  type: 'profile.avatar.errorType',
  size: 'profile.avatar.errorSize',
  failed: 'profile.avatar.errorFailed',
} as const satisfies Record<AvatarError, string>;

/**
 * FR-SET-1 (P10): upload a profile picture (a raster image of at most 2 MB, stored as a 256 px
 * WebP) or remove it to get the sign-in provider's back. Shown under the name in Profile.
 */
export function AvatarField({
  uploaded,
  pending,
  error,
  online,
  onUpload,
  onRemove,
}: AvatarFieldProps) {
  const { t } = useTranslation('settings');
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-col gap-2" data-testid="avatar-field">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          icon={ImageUp}
          isLoading={pending === 'upload'}
          isDisabled={!online || pending !== null}
          onPress={() => input.current?.click()}
          data-testid="avatar-upload"
        >
          {uploaded ? t('profile.avatar.change') : t('profile.avatar.upload')}
        </Button>
        {uploaded && (
          <Button
            size="sm"
            variant="ghost"
            icon={Trash2}
            isLoading={pending === 'remove'}
            isDisabled={!online || pending !== null}
            onPress={onRemove}
            data-testid="avatar-remove"
          >
            {t('profile.avatar.remove')}
          </Button>
        )}
        <input
          ref={input}
          type="file"
          accept={accept}
          hidden
          tabIndex={-1}
          aria-hidden
          data-testid="avatar-input"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) onUpload(file);
          }}
        />
      </div>
      <p className="text-sm text-text-muted">
        {online
          ? `${t('profile.avatar.hint')}${uploaded ? '' : ` ${t('profile.avatar.providerNote')}`}`
          : t('profile.avatar.offline')}
      </p>
      {error && (
        <Banner tone="danger" role="alert">
          {t(errorKeys[error])}
        </Banner>
      )}
    </div>
  );
}
