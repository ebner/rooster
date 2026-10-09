import { DEFAULT_PREFS } from '@rooster/core/limits';
import { defaultPrefEnabled, NOTIFICATION_PREF_CELLS } from '@rooster/core/notification-prefs';
import type { NotificationPref } from '@rooster/core/schemas';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PushKeysSection } from '../admin/push-keys-section';
import { Group } from '../dev-ui/layout';
import { fixturePushDevices } from './fixtures';
import { type DeliveryPrefs, NotificationsPage } from './notifications-page';
import { PushDeviceSection, type PushDeviceState } from './push-device-section';

/** `on` and `off` show with the device list above. */
const otherStates: readonly PushDeviceState[] = ['denied', 'ios-install', 'unsupported', 'loading'];

const noop = () => {};

/** `/_dev/ui` (P7): the notification matrix, push on this device, and push key rotation. */
export function DeliveryKitchenGroups() {
  const { t } = useTranslation('settings');
  const [prefs, setPrefs] = useState<NotificationPref[]>(() =>
    NOTIFICATION_PREF_CELLS.map(({ type, channel }) => ({
      type,
      channel,
      enabled: defaultPrefEnabled(type, channel),
    })),
  );
  const [delivery, setDelivery] = useState<DeliveryPrefs>({
    reminderTime: DEFAULT_PREFS.reminderTime,
    digestTime: DEFAULT_PREFS.digestTime,
    emailMode: DEFAULT_PREFS.emailMode,
  });
  const onChange = (type: NotificationPref['type'], enabled: boolean, channel: string) =>
    setPrefs((all) =>
      all.map((p) => (p.type === type && p.channel === channel ? { ...p, enabled } : p)),
    );
  const deliverySettings = {
    value: delivery,
    locale: 'en' as const,
    timeFormat: '24h' as const,
    onChange: (patch: Partial<DeliveryPrefs>) => setDelivery((d) => ({ ...d, ...patch })),
  };
  const device = (state: PushDeviceState, force?: string) => (
    <PushDeviceSection
      state={state}
      devices={fixturePushDevices}
      currentDeviceId="push-laptop"
      onEnable={noop}
      onDisable={noop}
      onTest={noop}
      onRemove={noop}
      onShowInstallSteps={noop}
      locale="en"
      now={Date.now()}
      {...(force ? { 'data-force': force } : {})}
    />
  );
  return (
    <>
      <Group title={t('dev.matrix')} className="block">
        <div className="max-w-pane-max">
          <NotificationsPage
            prefs={prefs}
            channels={{ push: true, email: true }}
            onChange={onChange}
            delivery={deliverySettings}
            layout="table"
            data-force="focus"
          />
        </div>
      </Group>
      <Group title={t('dev.matrixNoEmail')} className="block">
        <div className="max-w-pane-max">
          <NotificationsPage
            prefs={prefs}
            channels={{ push: true, email: false }}
            onChange={onChange}
            delivery={deliverySettings}
            layout="table"
          />
        </div>
      </Group>
      <Group title={t('dev.matrixPhone')} className="block">
        <div className="w-full max-w-pane-min">
          <NotificationsPage
            prefs={prefs}
            channels={{ push: true, email: true }}
            onChange={onChange}
            layout="stacked"
          />
        </div>
      </Group>
      <Group title={t('dev.devices')} className="flex-col items-stretch">
        <div className="max-w-pane-max">{device('on')}</div>
        <div className="max-w-pane-max">{device('off', 'hover')}</div>
        <div className="max-w-pane-max">
          <PushDeviceSection
            state="off"
            devices={[]}
            currentDeviceId={null}
            pending="enable"
            onEnable={noop}
            onDisable={noop}
            onTest={noop}
            onRemove={noop}
            onShowInstallSteps={noop}
            locale="en"
            now={Date.now()}
          />
        </div>
      </Group>
      <Group title={t('dev.pushStates')} className="flex-col items-stretch">
        {otherStates.map((state) => (
          <div key={state} className="max-w-pane-max">
            {device(state, state === 'ios-install' ? 'focus' : undefined)}
          </div>
        ))}
      </Group>
      <Group title={t('dev.pushKeys')} className="flex-col items-stretch">
        <div className="max-w-pane-max">
          <PushKeysSection onRegenerate={async () => {}} data-force="hover" />
        </div>
        <div className="max-w-pane-max">
          <PushKeysSection onRegenerate={async () => {}} defaultExpanded />
        </div>
      </Group>
    </>
  );
}
