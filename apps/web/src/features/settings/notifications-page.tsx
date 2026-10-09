import type { NotificationPref, NotificationType } from '@rooster/core/schemas';
import { Switch } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { Banner } from '../../ui/banner';
import { SkeletonRows } from '../../ui/skeleton';
import { SettingsSection } from './settings-section';

/**
 * The matrix rows, in `NOTIFICATION_TYPES` order. Spelled out here because the value lives in
 * the zod schemas module, which this lazy route would otherwise pull in whole.
 */
export const notificationTypes = [
  'assigned',
  'comment',
  'mention',
  'completed',
  'due_changed',
  'invite_accepted',
] as const satisfies readonly NotificationType[];

export interface NotificationsPageProps {
  /** Every event × channel cell (defaults applied); undefined while loading. */
  prefs: readonly NotificationPref[] | undefined;
  error?: Error | null | undefined;
  onChange: (type: NotificationType, enabled: boolean) => void;
  'data-force'?: string;
}

/** A 32 × 20 on/off switch (the in-app column's cells). */
function CellSwitch({
  label,
  isSelected,
  onChange,
  force,
}: {
  label: string;
  isSelected: boolean;
  onChange: (value: boolean) => void;
  force?: string | undefined;
}) {
  return (
    <Switch
      aria-label={label}
      isSelected={isSelected}
      onChange={onChange}
      {...(force ? { 'data-force': force } : {})}
      className="group/switch inline-flex cursor-default items-center outline-none pointer-coarse:min-h-hit-touch"
    >
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

/**
 * Settings → Notifications (FR-NOT-4): the event × channel matrix. Phase 6 has the in-app
 * column only; push and email join it in P7. Online-only, saved per change.
 */
export function NotificationsPage({
  prefs,
  error,
  onChange,
  'data-force': force,
}: NotificationsPageProps) {
  const { t } = useTranslation('settings');
  const enabled = (type: NotificationType) =>
    prefs?.find((p) => p.type === type && p.channel === 'inapp')?.enabled ?? true;
  return (
    <div className="flex flex-col gap-12">
      <SettingsSection title={t('notifications.title')} description={t('notifications.body')}>
        {error && !prefs ? (
          <Banner tone="danger" role="alert">
            {t('notifications.loadFailed')}
          </Banner>
        ) : !prefs ? (
          <SkeletonRows count={3} />
        ) : (
          <table className="w-full max-w-pane text-sm" data-testid="notification-prefs">
            <thead>
              <tr className="border-b border-border text-start text-xs text-text-muted">
                <th scope="col" className="py-2 text-start font-medium">
                  {t('notifications.event')}
                </th>
                <th scope="col" className="w-label-col py-2 text-center font-medium">
                  {t('notifications.inapp')}
                </th>
              </tr>
            </thead>
            <tbody>
              {notificationTypes.map((type, index) => (
                <tr key={type} className="border-b border-border last:border-b-0">
                  <th scope="row" className="py-2 pe-4 text-start font-normal text-text">
                    {t(`notifications.type.${type}`)}
                  </th>
                  <td className="py-2 text-center">
                    <CellSwitch
                      label={t('notifications.cell', {
                        event: t(`notifications.type.${type}`),
                        channel: t('notifications.inapp'),
                      })}
                      isSelected={enabled(type)}
                      onChange={(value) => onChange(type, value)}
                      force={index === 0 ? force : undefined}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SettingsSection>
    </div>
  );
}
