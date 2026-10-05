import { Info, Share, SquarePlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { BottomSheet } from '../../ui/bottom-sheet';
import { Button, iconStrokeWidth } from '../../ui/button';
import { useInstallStore } from './install';

export interface IosInstallStepsProps {
  onDone?: () => void;
}

/** The two Safari steps and the separate-storage note (02 §13.5). */
export function IosInstallSteps({ onDone }: IosInstallStepsProps) {
  const { t } = useTranslation('pwa');
  const steps = [
    { icon: Share, text: t('ios.step1') },
    { icon: SquarePlus, text: t('ios.step2') },
  ];
  return (
    <div className="flex flex-col gap-4 px-2 pb-2">
      <ol className="flex flex-col gap-3">
        {steps.map(({ icon: Icon, text }, index) => (
          <li key={text} className="flex items-center gap-3 text-md">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-bg-muted text-text-secondary">
              <Icon className="size-4" strokeWidth={iconStrokeWidth} aria-hidden />
            </span>
            <span>
              <span className="sr-only">{index + 1}. </span>
              {text}
            </span>
          </li>
        ))}
      </ol>
      <p className="flex items-start gap-2 rounded-md bg-bg-info-subtle px-3 py-2 text-sm text-text-info">
        <Info className="mt-0.5 size-4 shrink-0" strokeWidth={iconStrokeWidth} aria-hidden />
        {t('ios.signInNote')}
      </p>
      {onDone && (
        <Button variant="primary" size="lg" onPress={onDone} className="w-full">
          {t('ios.close')}
        </Button>
      )}
    </div>
  );
}

/** The iOS tip sheet: Safari cannot be prompted, so the app shows the way (02 §13.5). */
export function IosInstallSheet() {
  const { t } = useTranslation('pwa');
  const open = useInstallStore((s) => s.iosSheetOpen);
  const close = () => useInstallStore.setState({ iosSheetOpen: false });
  return (
    <BottomSheet
      isOpen={open}
      onOpenChange={(next) => useInstallStore.setState({ iosSheetOpen: next })}
      title={t('ios.title')}
    >
      <IosInstallSteps onDone={close} />
    </BottomSheet>
  );
}
