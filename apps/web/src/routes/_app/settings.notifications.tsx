import { DEFAULT_PREFS } from '@rooster/core/limits';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorCode } from '../../data/errors';
import { useDisplayPrefs, useMe, useServerFeatures } from '../../data/me';
import {
  type DeliveryPrefs,
  useNotificationPrefs,
  useUpdateDeliveryPrefs,
  useUpdateNotificationPrefs,
} from '../../data/notifications';
import {
  disablePush,
  enablePush,
  UnsupportedPushServiceError,
  usePushDevices,
  useRemovePushDevice,
  useSendTestPush,
  useThisDevice,
  useVapidKey,
} from '../../data/push';
import { openIosInstallSheet } from '../../features/pwa/install';
import { isIosDevice, notificationPermission, pushSupport } from '../../features/pwa/push-support';
import { NotificationsPage } from '../../features/settings/notifications-page';
import { PushDeviceSection, pushDeviceState } from '../../features/settings/push-device-section';
import { toast } from '../../ui/toast';

/** Settings → Notifications (FR-NOT-2…4, WP 7.1 and 7.4). Online-only. */
export const Route = createFileRoute('/_app/settings/notifications')({
  component: NotificationsRoute,
});

function NotificationsRoute() {
  const { t } = useTranslation('settings');
  const me = useMe();
  const features = useServerFeatures();
  const prefs = useNotificationPrefs();
  const update = useUpdateNotificationPrefs();
  const updateDelivery = useUpdateDeliveryPrefs();
  const display = useDisplayPrefs();
  const saved = () => toast({ message: t('profile.saved'), durationMs: 2500 });
  const failed = () => toast({ message: t('error.saveFailed'), tone: 'danger' });
  const delivery: DeliveryPrefs = {
    reminderTime: me.data?.prefs?.reminderTime ?? DEFAULT_PREFS.reminderTime,
    digestTime: me.data?.prefs?.digestTime ?? DEFAULT_PREFS.digestTime,
    emailMode: me.data?.prefs?.emailMode ?? DEFAULT_PREFS.emailMode,
  };
  return (
    <NotificationsPage
      prefs={features.data ? prefs.data : undefined}
      error={prefs.error ?? features.error}
      channels={features.data}
      onChange={(type, enabled, channel) =>
        update.mutateAsync([{ type, channel, enabled }]).then(saved).catch(failed)
      }
      delivery={{
        value: delivery,
        locale: display.locale,
        timeFormat: display.timeFormat,
        onChange: (patch) => updateDelivery.mutateAsync(patch).then(saved).catch(failed),
      }}
      push={features.data?.push && me.data && <PushSettings userId={me.data.user.id} />}
    />
  );
}

/** This device's subscription and the device list; push code loads with this route only. */
function PushSettings({ userId }: { userId: string }) {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const { locale } = useDisplayPrefs();
  const support = pushSupport();
  // The permission is read on render: every change to it goes through this page's buttons
  // or a reload after the user unblocks the site.
  const permission = notificationPermission();
  const vapid = useVapidKey(support === 'available');
  const devices = usePushDevices(true);
  const thisDevice = useThisDevice(support === 'available' ? userId : undefined, vapid.data);
  const sendTest = useSendTestPush();
  const remove = useRemovePushDevice(userId);
  const [pending, setPending] = useState<'enable' | 'disable' | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  const deviceId = thisDevice.data?.deviceId ?? null;
  const known = Boolean(deviceId && devices.data?.some((device) => device.id === deviceId));
  const state = pushDeviceState({
    support,
    permission,
    failed: Boolean(vapid.error || thisDevice.error || devices.error),
    subscribed: thisDevice.data && devices.data ? thisDevice.data.subscribed : undefined,
    known,
  });

  const enable = () => {
    const key = vapid.data;
    if (!key || pending) return;
    setPending('enable');
    // `requestPermission` runs first, inside the press: the prompt needs the user's gesture.
    enablePush(queryClient, userId, key)
      .then((result) => {
        if (result === 'on') toast({ message: t('push.enabled') });
        else if (result === 'denied') toast({ message: t('push.blockedTitle'), tone: 'danger' });
      })
      .catch((error: unknown) =>
        toast({
          message:
            error instanceof UnsupportedPushServiceError
              ? t('push.unsupportedService')
              : t('push.enableFailed'),
          tone: 'danger',
        }),
      )
      .finally(() => setPending(null));
  };

  const disable = () => {
    if (pending) return;
    setPending('disable');
    disablePush(queryClient, userId)
      .then(() => toast({ message: t('push.disabled') }))
      .catch(() => toast({ message: t('error.saveFailed'), tone: 'danger' }))
      .finally(() => setPending(null));
  };

  return (
    <PushDeviceSection
      state={state}
      devices={devices.data}
      currentDeviceId={known ? deviceId : null}
      iosApp={isIosDevice(navigator.userAgent, navigator.maxTouchPoints)}
      pending={pending}
      testingId={testingId}
      onEnable={enable}
      onDisable={disable}
      onTest={(id) => {
        setTestingId(id);
        sendTest
          .mutateAsync(id)
          .then(() => toast({ message: t('push.testSent') }))
          .catch((error: unknown) =>
            toast({
              message: errorCode(error) === 'push_gone' ? t('push.testGone') : t('push.testFailed'),
              tone: 'danger',
            }),
          )
          .finally(() => setTestingId(null));
      }}
      onRemove={(id) =>
        remove
          .mutateAsync(id)
          .then(() => toast({ message: t('push.removed') }))
          .catch(() => toast({ message: t('error.saveFailed'), tone: 'danger' }))
      }
      onShowInstallSteps={openIosInstallSheet}
      locale={locale}
      now={Date.now()}
    />
  );
}
