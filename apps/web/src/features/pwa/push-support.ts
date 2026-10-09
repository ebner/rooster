import { isStandalone } from './install';
import { serviceWorkerEnabled } from './sw-enabled';

/**
 * What this browser can do about Web Push (FR-NOT-2):
 * - `ios-install`: an iPhone or iPad outside the installed app, where push does not exist; the
 *   user adds rooster to the Home Screen first (02 §13.5).
 * - `unsupported`: no Push API, or no service worker (`vite` dev without VITE_PWA_DEV=1).
 * - `available`: push can be turned on; the permission decides the rest.
 */
export type PushSupport = 'available' | 'ios-install' | 'unsupported';

export interface PushEnvironment {
  userAgent: string;
  maxTouchPoints: number;
  standalone: boolean;
  serviceWorker: boolean;
  pushManager: boolean;
  notifications: boolean;
}

/**
 * iPhone or iPad, in any browser: all of them are WebKit, and push exists only in a Home
 * Screen app there (iOS 16.4+). The installed app's user agent has no `Safari/`.
 */
export function isIosDevice(userAgent: string, maxTouchPoints: number): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

export function pushSupport(env: PushEnvironment = currentEnvironment()): PushSupport {
  if (isIosDevice(env.userAgent, env.maxTouchPoints) && !env.standalone) return 'ios-install';
  if (!env.serviceWorker || !env.pushManager || !env.notifications) return 'unsupported';
  return 'available';
}

function currentEnvironment(): PushEnvironment {
  const hasWindow = typeof window !== 'undefined';
  return {
    userAgent: hasWindow ? navigator.userAgent : '',
    maxTouchPoints: hasWindow ? navigator.maxTouchPoints : 0,
    standalone: isStandalone(),
    serviceWorker: serviceWorkerEnabled(),
    pushManager: hasWindow && 'PushManager' in window,
    notifications: hasWindow && 'Notification' in window,
  };
}

/** The browser's notification permission; `default` until the user answers the prompt. */
export function notificationPermission(): NotificationPermission {
  return typeof Notification === 'undefined' ? 'default' : Notification.permission;
}
