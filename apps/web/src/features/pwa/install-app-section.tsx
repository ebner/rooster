import { CircleCheck, Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, iconStrokeWidth } from '../../ui/button';
import { SettingsSection } from '../settings/settings-section';
import { installPlatform, openIosInstallSheet, promptInstall, useInstallStore } from './install';

/**
 * Settings → Install app (02 §13.5): the browser's install dialog where there is one, the
 * iOS steps on Safari, otherwise a pointer to the browser menu.
 */
export function InstallAppSection() {
  const { t } = useTranslation('pwa');
  const deferred = useInstallStore((s) => s.deferred);
  const installed = useInstallStore((s) => s.installed);
  const platform = installPlatform({ deferred });
  return (
    <SettingsSection id="install" title={t('install.title')} description={t('install.body')}>
      {installed ? (
        <p className="flex items-center gap-2 text-sm text-text-success">
          <CircleCheck className="size-4" strokeWidth={iconStrokeWidth} aria-hidden />
          {t('install.installed')}
        </p>
      ) : platform === 'prompt' ? (
        <div>
          <Button variant="primary" icon={Download} onPress={() => void promptInstall()}>
            {t('install.button')}
          </Button>
        </div>
      ) : platform === 'ios' ? (
        <div>
          <Button icon={Download} onPress={openIosInstallSheet}>
            {t('install.iosButton')}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-text-secondary">{t('install.otherHint')}</p>
      )}
    </SettingsSection>
  );
}
