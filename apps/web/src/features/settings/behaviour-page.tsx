import { SWIPE_ACTIONS, type SwipeAction } from '@rooster/core/schemas';
import { useTranslation } from 'react-i18next';
import { Select } from '../../ui/select';
import { SwipeReveal } from '../../ui/swipe-reveal';
import { SettingsSection } from './settings-section';

export interface SwipeSettings {
  swipeLeft: SwipeAction;
  swipeRight: SwipeAction;
}

export interface BehaviourPageProps {
  value: SwipeSettings;
  onChange: (patch: Partial<SwipeSettings>) => void;
}

/** One direction: the action select and a preview of what the swipe uncovers. */
function SwipeField({
  label,
  side,
  value,
  onChange,
}: {
  label: string;
  side: 'start' | 'end';
  value: SwipeAction;
  onChange: (value: SwipeAction) => void;
}) {
  const { t } = useTranslation('settings');
  const { t: tm } = useTranslation('mobile');
  return (
    <div className="flex flex-col gap-2">
      <Select
        label={label}
        options={SWIPE_ACTIONS.map((id) => ({ id, label: t(`behaviour.action.${id}`) }))}
        value={value}
        onChange={onChange}
        className="max-w-pane-min"
      />
      <div className="relative h-row-mobile max-w-pane-min overflow-hidden rounded-sm bg-bg-subtle">
        {value !== 'none' && (
          <SwipeReveal
            action={value}
            side={side}
            armed
            label={tm(`swipe.${value}`)}
            className="absolute inset-0"
          />
        )}
        <div
          aria-hidden
          className={
            value === 'none'
              ? 'absolute inset-0 flex items-center rounded-sm border border-border bg-bg-app px-4 text-sm text-text-muted'
              : side === 'start'
                ? 'absolute inset-y-0 start-1/3 end-0 flex items-center rounded-s-sm border border-border bg-bg-app px-4 text-sm text-text-muted'
                : 'absolute inset-y-0 start-0 end-1/3 flex items-center rounded-e-sm border border-border bg-bg-app px-4 text-sm text-text-muted'
          }
        >
          {t('behaviour.sampleTask')}
        </div>
      </div>
    </div>
  );
}

/**
 * Settings → Behaviour (FR-SET-2): the phone's swipe actions, one per direction (02 §13.2).
 * Saved to `user.prefs` at once.
 */
export function BehaviourPage({ value, onChange }: BehaviourPageProps) {
  const { t } = useTranslation('settings');
  return (
    <div className="flex flex-col gap-12">
      <SettingsSection title={t('behaviour.swipeTitle')} description={t('behaviour.swipeBody')}>
        <SwipeField
          label={t('behaviour.swipeRight')}
          side="start"
          value={value.swipeRight}
          onChange={(swipeRight) => onChange({ swipeRight })}
        />
        <SwipeField
          label={t('behaviour.swipeLeft')}
          side="end"
          value={value.swipeLeft}
          onChange={(swipeLeft) => onChange({ swipeLeft })}
        />
      </SettingsSection>
    </div>
  );
}
