import type { TimeFormat } from '@rooster/core/dates';
import { formatTime } from '@rooster/core/dates';
import { DEFAULT_PREFS } from '@rooster/core/limits';
import {
  defaultPrefEnabled,
  isPrefCell,
  NOTIFICATION_PREF_CHANNELS,
  NOTIFICATION_PREF_TYPES,
  type NotificationPrefChannel,
  type NotificationPrefType,
} from '@rooster/core/notification-prefs';
import type { NotificationPref, NotificationType, Prefs } from '@rooster/core/schemas';
import type { Locale } from '@rooster/i18n/core';
import type { ReactNode } from 'react';
import { Switch } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { Banner } from '../../ui/banner';
import { SegmentedControl } from '../../ui/segmented-control';
import { Select } from '../../ui/select';
import { SkeletonRows } from '../../ui/skeleton';
import { useIsMobile } from '../../ui/use-media';
import { SettingsSection } from './settings-section';

/**
 * The seven event rows, in `NOTIFICATION_EVENT_TYPES` order. Spelled out here because the value
 * lives next to the zod schemas, which this lazy route would otherwise pull in whole. The
 * `device_connected` security notice is outside the matrix (11 §9.4).
 */
export const notificationTypes = [
  'assigned',
  'comment',
  'mention',
  'completed',
  'due_changed',
  'invite_accepted',
  'reminder',
] as const satisfies readonly NotificationType[];

/** The channels this server delivers (`/meta` features); in-app always exists. */
export interface NotificationChannels {
  push: boolean;
  email: boolean;
}

/**
 * The timing prefs this page edits. `allDayReminderTime` (P10, FR-REM-2) is optional for callers
 * that predate it; the page then shows the default.
 */
export type DeliveryPrefs = Pick<Prefs, 'reminderTime' | 'digestTime' | 'emailMode'> &
  Partial<Pick<Prefs, 'allDayReminderTime'>>;

export interface DeliverySettings {
  value: DeliveryPrefs;
  locale: Locale;
  timeFormat: TimeFormat;
  onChange: (patch: Partial<DeliveryPrefs>) => void;
}

export interface NotificationsPageProps {
  /** Every cell (defaults applied); undefined while loading. */
  prefs: readonly NotificationPref[] | undefined;
  error?: Error | null | undefined;
  /** Without it only the in-app column shows (Phase 6, or features still loading). */
  channels?: NotificationChannels | undefined;
  onChange: (
    type: NotificationPrefType,
    enabled: boolean,
    channel: NotificationPrefChannel,
  ) => void;
  /** Reminder and digest times and the email mode (FR-NOT-2/3); hidden when absent. */
  delivery?: DeliverySettings | undefined;
  /** This device's push subscription and the device list (WP 7.1). */
  push?: ReactNode;
  /** The phone's stacked list or the matrix table; follows the viewport by default. */
  layout?: 'table' | 'stacked';
  'data-force'?: string;
}

/** A 32 × 20 on/off switch; `children` makes the whole row the hit target (phones). */
function CellSwitch({
  label,
  isSelected,
  onChange,
  force,
  children,
  className,
}: {
  label: string;
  isSelected: boolean;
  onChange: (value: boolean) => void;
  force?: string | undefined;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Switch
      aria-label={label}
      isSelected={isSelected}
      onChange={onChange}
      {...(force ? { 'data-force': force } : {})}
      className={cn(
        'group/switch inline-flex cursor-default items-center outline-none pointer-coarse:min-h-hit-touch',
        className,
      )}
    >
      {children}
      <span
        className={cn(
          'flex h-5 w-8 shrink-0 items-center rounded-full bg-text-muted p-0.5',
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

/** Half-hour steps; a stored time off that grid (set through the API) is kept as an option. */
function timeOptions(current: string, locale: Locale, timeFormat: TimeFormat) {
  const times = Array.from({ length: 48 }, (_, i) => {
    const hour = String(Math.floor(i / 2)).padStart(2, '0');
    return `${hour}:${i % 2 === 0 ? '00' : '30'}`;
  });
  if (!times.includes(current)) times.push(current);
  times.sort();
  return times.map((id) => ({ id, label: formatTime(id, locale, timeFormat) }));
}

/**
 * Settings → Notifications (FR-NOT-2…4): the event × channel matrix, the reminder and digest
 * times, the email mode, and push on this device. Channels the server cannot deliver are
 * left out (AC-7.3). Online-only, saved per change.
 */
export function NotificationsPage({
  prefs,
  error,
  channels,
  onChange,
  delivery,
  push,
  layout,
  'data-force': force,
}: NotificationsPageProps) {
  const { t } = useTranslation('settings');
  const isMobile = useIsMobile();
  const stacked = (layout ?? (isMobile ? 'stacked' : 'table')) === 'stacked';
  const columns = NOTIFICATION_PREF_CHANNELS.filter(
    (channel) => channel === 'inapp' || channels?.[channel] === true,
  );
  const rows = NOTIFICATION_PREF_TYPES.filter((type) =>
    columns.some((channel) => isPrefCell(type, channel)),
  );
  const enabled = (type: NotificationPrefType, channel: NotificationPrefChannel) =>
    prefs?.find((p) => p.type === type && p.channel === channel)?.enabled ??
    defaultPrefEnabled(type, channel);
  const typeLabel = (type: NotificationPrefType) => t(`notifications.type.${type}`);
  const channelLabel = (channel: NotificationPrefChannel) => t(`notifications.${channel}`);
  const cellLabel = (type: NotificationPrefType, channel: NotificationPrefChannel) =>
    t('notifications.cell', { event: typeLabel(type), channel: channelLabel(channel) });
  // Only the first switch carries a forced kitchen-sink state.
  const forceFor = (type: NotificationPrefType, channel: NotificationPrefChannel) =>
    type === rows[0] && channel === columns[0] ? force : undefined;
  const email = channels?.email === true;
  const pushOn = channels?.push === true;
  const allDayTime = delivery?.value.allDayReminderTime ?? DEFAULT_PREFS.allDayReminderTime;

  const matrix =
    error && !prefs ? (
      <Banner tone="danger" role="alert">
        {t('notifications.loadFailed')}
      </Banner>
    ) : !prefs ? (
      <SkeletonRows count={3} />
    ) : stacked ? (
      <ul className="flex flex-col" data-testid="notification-prefs">
        {rows.map((type) => (
          <li
            key={type}
            className="flex flex-col gap-1 border-b border-border py-3 last:border-b-0"
          >
            <span className="text-sm font-medium text-text">{typeLabel(type)}</span>
            {columns
              .filter((channel) => isPrefCell(type, channel))
              .map((channel) => (
                <CellSwitch
                  key={channel}
                  label={cellLabel(type, channel)}
                  isSelected={enabled(type, channel)}
                  onChange={(value) => onChange(type, value, channel)}
                  force={forceFor(type, channel)}
                  className="min-h-hit-touch w-full justify-between gap-4 text-sm text-text-secondary"
                >
                  <span aria-hidden>{channelLabel(channel)}</span>
                </CellSwitch>
              ))}
          </li>
        ))}
      </ul>
    ) : (
      <table className="w-full max-w-pane text-sm" data-testid="notification-prefs">
        <thead>
          <tr className="border-b border-border text-start text-xs text-text-muted">
            <th scope="col" className="py-2 text-start font-medium">
              {t('notifications.event')}
            </th>
            {columns.map((channel) => (
              <th key={channel} scope="col" className="w-16 py-2 text-center font-medium">
                {channelLabel(channel)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((type) => (
            <tr key={type} className="border-b border-border last:border-b-0">
              <th scope="row" className="py-2 pe-4 text-start font-normal text-text">
                {typeLabel(type)}
              </th>
              {columns.map((channel) => (
                <td key={channel} className="py-2 text-center">
                  {isPrefCell(type, channel) && (
                    <CellSwitch
                      label={cellLabel(type, channel)}
                      isSelected={enabled(type, channel)}
                      onChange={(value) => onChange(type, value, channel)}
                      force={forceFor(type, channel)}
                    />
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );

  return (
    <div className="flex flex-col gap-12">
      <SettingsSection
        title={t('notifications.title')}
        description={t('notifications.body')}
        isPageTitle
      >
        {matrix}
      </SettingsSection>
      {delivery && (
        <SettingsSection
          title={t('notifications.timingTitle')}
          description={t('notifications.timingBody')}
        >
          {/* Task reminders (FR-REM-2) reach the inbox on every server, so this one always shows. */}
          <Select
            label={t('notifications.allDayReminderTime')}
            description={t('notifications.allDayReminderTimeHint')}
            options={timeOptions(allDayTime, delivery.locale, delivery.timeFormat)}
            value={allDayTime}
            onChange={(allDayReminderTime) => delivery.onChange({ allDayReminderTime })}
            className="max-w-pane-min"
          />
          {pushOn && (
            <Select
              label={t('notifications.reminderTime')}
              description={t('notifications.reminderTimeHint')}
              options={timeOptions(
                delivery.value.reminderTime,
                delivery.locale,
                delivery.timeFormat,
              )}
              value={delivery.value.reminderTime}
              onChange={(reminderTime) => delivery.onChange({ reminderTime })}
              className="max-w-pane-min"
            />
          )}
          {email && (
            <Select
              label={t('notifications.digestTime')}
              description={t('notifications.digestTimeHint')}
              options={timeOptions(delivery.value.digestTime, delivery.locale, delivery.timeFormat)}
              value={delivery.value.digestTime}
              onChange={(digestTime) => delivery.onChange({ digestTime })}
              className="max-w-pane-min"
            />
          )}
          {email && (
            <SegmentedControl
              label={t('notifications.emailMode')}
              description={t('notifications.emailModeHint')}
              options={[
                { id: 'immediate', label: t('notifications.emailImmediate') },
                { id: 'batch', label: t('notifications.emailBatch') },
              ]}
              value={delivery.value.emailMode}
              onChange={(emailMode) => delivery.onChange({ emailMode })}
            />
          )}
        </SettingsSection>
      )}
      {pushOn && push}
    </div>
  );
}
