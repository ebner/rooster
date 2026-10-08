import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { syncEngine } from '../../data/sync/engine';
import { useSyncStore } from '../../state/sync-store';
import { dismissToast, toast } from '../../ui/toast';
import {
  claimInstallToast,
  countVisit,
  installPlatform,
  listenForInstall,
  openIosInstallSheet,
  promptInstall,
  useInstallStore,
} from './install';
import { IosInstallSheet } from './ios-install-sheet';
import { registerServiceWorker, unregisterServiceWorkerHandlers } from './sw-registration';
import { createUpdateController, setUpdateController } from './update-controller';
import { isEditingText } from './update-gate';

/** The update toast stays until acted on (the browser caps timers at ~24.8 days). */
const updateToastMs = 24 * 60 * 60 * 1000;
const installToastMs = 12_000;

export interface PwaRootProps {
  /** In-app navigation for notification clicks (the router lives outside this tree). */
  navigate: (path: string) => void;
}

/**
 * Mounted once next to the router: registers the service worker and runs the update flow
 * (FR-PWA-6: the toast here, the header chip in `SyncStatus`), the one-time install toasts and
 * the iOS tip sheet (02 §13.5).
 */
export function PwaRoot({ navigate }: PwaRootProps) {
  const { t: translate } = useTranslation('pwa');
  // The current language at the time a toast shows; effects must not re-run on a switch.
  const tRef = useRef(translate);
  tRef.current = translate;

  useEffect(() => {
    let promptId: string | null = null;
    const handlers = {
      onNeedRefresh: () => controller.needRefresh(),
      onControllerChange: () => controller.controllerChange(),
    };
    const controller = createUpdateController({
      sw: registerServiceWorker(handlers),
      pending: () => useSyncStore.getState().pending,
      editing: () => isEditingText(),
      subscribe: (listener) => {
        // Focus has not moved yet during `focusout`: look once it has.
        const onFocusOut = () => setTimeout(listener, 0);
        const unsubscribe = useSyncStore.subscribe(listener);
        document.addEventListener('focusout', onFocusOut);
        return () => {
          unsubscribe();
          document.removeEventListener('focusout', onFocusOut);
        };
      },
      reload: () => location.reload(),
      prompt: () => {
        if (promptId) dismissToast(promptId);
        promptId = toast({
          message: tRef.current('update.available'),
          durationMs: updateToastMs,
          action: { label: tRef.current('update.reload'), onAction: () => controller.request() },
        });
      },
      deferredNotice: () => {
        toast({ message: tRef.current('update.deferred') });
        syncEngine()?.syncNow();
      },
    });
    setUpdateController(controller);
    syncEngine()?.setUpdateCheck(() => void controller.serverNewer());
    const onVisibility = () => {
      if (document.visibilityState === 'visible') controller.foreground('visible');
    };
    const onOnline = () => controller.foreground('online');
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      unregisterServiceWorkerHandlers(handlers);
      syncEngine()?.setUpdateCheck(() => {});
      setUpdateController(null);
      controller.dispose();
    };
  }, []);

  useEffect(() => {
    const visits = countVisit();
    const unlisten = listenForInstall(() => {
      if (!claimInstallToast(visits)) return;
      toast({
        message: tRef.current('install.toast'),
        durationMs: installToastMs,
        action: { label: tRef.current('install.action'), onAction: () => void promptInstall() },
      });
    });
    const { installed, deferred } = useInstallStore.getState();
    if (!installed && installPlatform({ deferred }) === 'ios' && claimInstallToast(visits)) {
      toast({
        message: tRef.current('install.iosToast'),
        durationMs: installToastMs,
        action: { label: tRef.current('install.iosAction'), onAction: openIosInstallSheet },
      });
    }
    return unlisten;
  }, []);

  // A notification click focused this window (sw.ts): open the task in place.
  useEffect(() => {
    const sw = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker;
    if (!sw) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; path?: unknown } | null;
      if (data?.type === 'rooster:navigate' && typeof data.path === 'string') {
        if (data.path.startsWith('/') && !data.path.startsWith('//')) navigate(data.path);
      }
    };
    sw.addEventListener('message', onMessage);
    return () => sw.removeEventListener('message', onMessage);
  }, [navigate]);

  return <IosInstallSheet />;
}
