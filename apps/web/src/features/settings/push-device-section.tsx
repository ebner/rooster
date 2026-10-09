import type { PushSubscriptionInfo } from '@rooster/core/schemas';
import type { Locale } from '@rooster/i18n/core';
import {
  BellOff,
  BellRing,
  CircleCheck,
  Download,
  Monitor,
  Smartphone,
  Tablet,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatTimeAgo } from '../../lib/format';
import { Banner } from '../../ui/banner';
import { Button, iconStrokeWidth } from '../../ui/button';
import { Chip } from '../../ui/chip';
import { SkeletonRows } from '../../ui/skeleton';
import { SettingsSection } from './settings-section';
import { describeUserAgent } from './user-agent';

/**
 * This browser's push state:
 * - `on`/`off`: subscribed with the current key and known to the server, or not.
 * - `denied`: the user blocked notifications for the site.
 * - `ios-install`: iOS Safari outside the installed app (no push there).
 * - `unsupported`: no Push API or no service worker.
 */
export type PushDeviceState = 'loading' | 'on' | 'off' | 'denied' | 'ios-install' | 'unsupported';

export interface PushDeviceInput {
  support: 'available' | 'ios-install' | 'unsupported';
  permission: NotificationPermission;
  /** The key, this browser's subscription or the device list failed to load. */
  failed: boolean;
  /** This browser holds a subscription on the current key; undefined while loading. */
  subscribed: boolean | undefined;
  /** The server lists this browser's subscription (not removed from another device). */
  known: boolean;
}

/** Push is `on` only when the browser, the permission and the server all agree. */
export function pushDeviceState(input: PushDeviceInput): PushDeviceState {
  if (input.support !== 'available') return input.support;
  if (input.permission === 'denied') return 'denied';
  if (input.failed) return 'unsupported';
  if (input.subscribed === undefined) return 'loading';
  return input.subscribed && input.known && input.permission === 'granted' ? 'on' : 'off';
}

export interface PushDeviceSectionProps {
  state: PushDeviceState;
  devices: readonly PushSubscriptionInfo[] | undefined;
  /** The server id of this browser's subscription, to mark it "This device". */
  currentDeviceId: string | null;
  /** The installed iOS app: notification settings live in the system Settings app. */
  iosApp?: boolean;
  pending?: 'enable' | 'disable' | null;
  /** The device a test push is going to (spinner on its button). */
  testingId?: string | null;
  onEnable: () => void;
  onDisable: () => void;
  onTest: (id: string) => void;
  onRemove: (id: string) => void;
  /** Opens the iOS "Add to Home Screen" sheet (02 §13.5). */
  onShowInstallSteps: () => void;
  locale: Locale;
  now: number;
  'data-force'?: string;
}

const deviceIcons = { desktop: Monitor, mobile: Smartphone, tablet: Tablet } as const;

/** Settings → Notifications → Push (FR-NOT-2, WP 7.1): opt in per device, list devices. */
export function PushDeviceSection({
  state,
  devices,
  currentDeviceId,
  iosApp = false,
  pending = null,
  testingId = null,
  onEnable,
  onDisable,
  onTest,
  onRemove,
  onShowInstallSteps,
  locale,
  now,
  'data-force': force,
}: PushDeviceSectionProps) {
  const { t } = useTranslation('settings');
  const { t: ts } = useTranslation('settings', { keyPrefix: 'security' });
  const forced = force ? { 'data-force': force } : {};

  const status =
    state === 'loading' ? (
      <SkeletonRows count={1} />
    ) : state === 'on' ? (
      <div className="flex flex-col gap-3 tablet:flex-row tablet:items-center tablet:justify-between">
        <p className="flex items-center gap-2 text-sm text-text-success" role="status">
          <CircleCheck className="size-4 shrink-0" strokeWidth={iconStrokeWidth} aria-hidden />
          {t('push.on')}
        </p>
        <div className="shrink-0">
          <Button icon={BellOff} isLoading={pending === 'disable'} onPress={onDisable} {...forced}>
            {t('push.turnOff')}
          </Button>
        </div>
      </div>
    ) : state === 'off' ? (
      <div>
        <Button
          variant="primary"
          icon={BellRing}
          isLoading={pending === 'enable'}
          onPress={onEnable}
          {...forced}
        >
          {t('push.turnOn')}
        </Button>
      </div>
    ) : state === 'denied' ? (
      <Banner tone="warning" title={t('push.blockedTitle')}>
        {iosApp ? t('push.blockedIos') : t('push.blockedBody')}
      </Banner>
    ) : state === 'ios-install' ? (
      <div className="flex flex-col gap-3">
        <Banner tone="info" title={t('push.iosTitle')}>
          {t('push.iosBody')}
        </Banner>
        <div>
          <Button icon={Download} onPress={onShowInstallSteps} {...forced}>
            {t('push.iosSteps')}
          </Button>
        </div>
      </div>
    ) : (
      <p className="text-sm text-text-secondary">{t('push.unsupported')}</p>
    );

  return (
    <SettingsSection id="push" title={t('push.title')} description={t('push.body')}>
      <div data-testid="push-state" data-state={state}>
        {status}
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">{t('push.devicesTitle')}</h3>
        {!devices ? (
          <SkeletonRows count={2} />
        ) : devices.length === 0 ? (
          <p className="text-sm text-text-muted">{t('push.noDevices')}</p>
        ) : (
          <ul className="flex flex-col" data-testid="push-devices">
            {devices.map((device) => {
              const described = describeUserAgent(device.userAgent);
              const Icon = deviceIcons[described.kind];
              const name =
                described.browser && described.os
                  ? ts('browserOnOs', { browser: described.browser, os: described.os })
                  : (described.browser ?? described.os ?? ts('unknownDevice'));
              const delivered =
                device.lastOkAt === null
                  ? t('push.neverDelivered')
                  : t('push.lastDelivered', {
                      when: formatTimeAgo(device.lastOkAt, now, locale, ts('justNow')),
                    });
              const isCurrent = device.id === currentDeviceId;
              return (
                <li
                  key={device.id}
                  className="flex flex-col gap-2 border-b border-border py-3 last:border-b-0 tablet:flex-row tablet:items-center tablet:gap-3"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-bg-muted text-text-secondary">
                      <Icon className="size-4" strokeWidth={iconStrokeWidth} aria-hidden />
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium">{name}</span>
                        {isCurrent && <Chip color="green">{ts('thisDevice')}</Chip>}
                      </span>
                      <span className="truncate text-sm text-text-muted">{delivered}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2 ps-11 tablet:ps-0">
                    <Button
                      size="sm"
                      isLoading={testingId === device.id}
                      onPress={() => onTest(device.id)}
                      aria-label={t('push.testNamed', { name })}
                    >
                      {t('push.test')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onPress={() => onRemove(device.id)}
                      aria-label={t('push.removeNamed', { name })}
                    >
                      {t('push.remove')}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </SettingsSection>
  );
}
