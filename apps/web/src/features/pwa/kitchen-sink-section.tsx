import { useTranslation } from 'react-i18next';
import { BottomSheet } from '../../ui/bottom-sheet';
import { ToastView } from '../../ui/toast';
import { Group, Section } from '../dev-ui/layout';
import { InstallAppSection } from './install-app-section';
import { IosInstallSteps } from './ios-install-sheet';
import { SessionExpired } from './sync-status';

/** `/_dev/ui`: the Phase 4 PWA surfaces (the sync pill states are in the Sync pill section). */
export function PwaKitchenSection() {
  const { t } = useTranslation('dev');
  const { t: tp } = useTranslation('pwa');
  return (
    <Section id="pwa" title={t('section.pwa')}>
      <Group title={t('group.sessionExpired')}>
        <SessionExpired />
      </Group>
      <Group title={t('group.updateToast')}>
        <ToastView
          live={false}
          message={tp('update.available')}
          action={{ label: tp('update.reload'), onAction: () => {} }}
          onDismiss={() => {}}
        />
        <ToastView live={false} message={tp('update.deferred')} onDismiss={() => {}} />
      </Group>
      <Group title={t('group.iosSheet')}>
        <div className="w-full max-w-sm">
          <BottomSheet isStatic isOpen onOpenChange={() => {}} title={tp('ios.title')}>
            <IosInstallSteps onDone={() => {}} />
          </BottomSheet>
        </div>
      </Group>
      <Group title={t('group.installSection')}>
        <div className="w-full max-w-pane-max">
          <InstallAppSection />
        </div>
      </Group>
    </Section>
  );
}
