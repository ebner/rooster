import { SWIPE_ACTIONS } from '@rooster/core/limits';
import type { SwipeAction } from '@rooster/core/schemas';
import { Switch, Text } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { SegmentedControl } from '../../ui/segmented-control';
import { Select } from '../../ui/select';
import { SwipeReveal } from '../../ui/swipe-reveal';
import { completeHideChoices, holdsUntilReload } from '../list/hide-delay';
import { SettingsSection } from './settings-section';

export interface BehaviourSettings {
  /** 02 §8: recognise dates such as "fri" in task names. */
  parseTitleDates: boolean;
  /** 02 §3.6: how long a completed task stays (10 000: until reload, `hide-delay.ts`). */
  completeHideMs: number;
  swipeLeft: SwipeAction;
  swipeRight: SwipeAction;
}

export interface BehaviourPageProps {
  value: BehaviourSettings;
  onChange: (patch: Partial<BehaviourSettings>) => void;
  /** Kitchen sink: a forced state on the switch (`data-force`). */
  'data-force'?: string;
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

/** A labelled on/off switch with a description; the whole row is the hit target. */
function SettingSwitch({
  label,
  description,
  isSelected,
  onChange,
  force,
}: {
  label: string;
  description: string;
  isSelected: boolean;
  onChange: (value: boolean) => void;
  force?: string | undefined;
}) {
  return (
    <Switch
      isSelected={isSelected}
      onChange={onChange}
      {...(force ? { 'data-force': force } : {})}
      className="group/switch flex max-w-pane-min cursor-default items-start justify-between gap-4 outline-none pointer-coarse:min-h-hit-touch"
    >
      <span className="flex min-w-0 flex-col gap-1">
        <span className="text-base text-text">{label}</span>
        <Text slot="description" className="text-sm text-text-muted">
          {description}
        </Text>
      </span>
      <span
        aria-hidden
        className={cn(
          'mt-0.5 flex h-5 w-8 shrink-0 items-center rounded-full bg-text-muted p-0.5',
          'transition-colors duration-(--dur-fast) ease-standard',
          'group-data-selected/switch:bg-bg-accent',
          'group-data-focus-visible/switch:outline-2 group-data-focus-visible/switch:outline-offset-2 group-data-focus-visible/switch:outline-border-focus',
          'group-data-[force~=focus]/switch:outline-2 group-data-[force~=focus]/switch:outline-offset-2 group-data-[force~=focus]/switch:outline-border-focus',
        )}
      >
        <span
          className={cn(
            'size-4 rounded-full bg-bg-elevated shadow-sm',
            'transition-transform duration-(--dur-fast) ease-standard motion-reduce:transition-none',
            'group-data-selected/switch:translate-x-3 rtl:group-data-selected/switch:-translate-x-3',
          )}
        />
      </span>
    </Switch>
  );
}

/** The hide-delay choices; a value set through the API outside them is kept as a choice. */
export function hideDelayValues(current: number): number[] {
  const values: number[] = [...completeHideChoices];
  if (!holdsUntilReload(current) && !values.includes(current)) {
    values.push(current);
    values.sort((a, b) => a - b);
  }
  return values;
}

/**
 * Settings → Behaviour (FR-SET-2): dates in task names (02 §8), how long a completed task
 * stays (02 §3.6), and the phone's swipe actions, one per direction (02 §13.2). Each change is
 * saved to `user.prefs` at once.
 */
export function BehaviourPage({ value, onChange, 'data-force': force }: BehaviourPageProps) {
  const { t } = useTranslation('settings');
  const hideValue = holdsUntilReload(value.completeHideMs)
    ? String(completeHideChoices[2])
    : String(value.completeHideMs);
  return (
    <div className="flex flex-col gap-12">
      <SettingsSection title={t('behaviour.datesTitle')}>
        <SettingSwitch
          label={t('behaviour.parseTitleDates')}
          description={t('behaviour.parseTitleDatesBody')}
          isSelected={value.parseTitleDates}
          onChange={(parseTitleDates) => onChange({ parseTitleDates })}
          force={force}
        />
      </SettingsSection>
      <SettingsSection title={t('behaviour.completedTitle')}>
        <SegmentedControl
          label={t('behaviour.hideAfter.label')}
          description={t('behaviour.hideAfter.body')}
          options={hideDelayValues(value.completeHideMs).map((ms) => ({
            id: String(ms),
            label: holdsUntilReload(ms)
              ? t('behaviour.hideAfter.untilReload')
              : t('behaviour.hideAfter.seconds', { seconds: ms / 1000 }),
          }))}
          value={hideValue}
          onChange={(next) => onChange({ completeHideMs: Number(next) })}
        />
      </SettingsSection>
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
