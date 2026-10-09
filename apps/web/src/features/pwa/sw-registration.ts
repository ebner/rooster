import { serviceWorkerEnabled } from './sw-enabled';

/**
 * What an update check found: `found` a new worker is installing or waiting (`onNeedRefresh`
 * follows), `current` the active worker is the server's latest, `unknown` no answer (offline,
 * network error).
 */
export type UpdateCheckResult = 'found' | 'current' | 'unknown';

export interface ServiceWorkerControls {
  /** Activates the waiting worker (`SKIP_WAITING`); `onControllerChange` follows. */
  apply(): void;
  /** A new version waits for `apply`. */
  hasWaiting(): boolean;
  /** Asks the browser to look for a new `sw.js` now (SSE `hello`, foreground, hourly). */
  check(): Promise<UpdateCheckResult>;
}

export interface ServiceWorkerHandlers {
  onNeedRefresh: () => void;
  /**
   * A new worker took control of this page: this tab asked for it, or another tab did. The
   * page still runs the old bundle, so it must reload, but only through the update gate.
   */
  onControllerChange: () => void;
}

export { serviceWorkerEnabled } from './sw-enabled';

const hourlyMs = 60 * 60 * 1000;

let registration: Promise<ServiceWorkerControls | null> | null = null;
const listeners = new Set<ServiceWorkerHandlers>();
let needsRefresh = false;

/**
 * Registers `sw.js` through workbox-window (vite-plugin-pwa's `registerType: 'prompt'`): a new
 * version waits until the user chooses to reload (FR-PWA-6, 04 §6.3). Registers once per page;
 * later calls share it (StrictMode mounts effects twice). Resolves to null when there is no
 * working service worker (unsupported, disabled, or the registration failed): the caller then
 * reloads the page itself.
 */
export function registerServiceWorker(
  handlers: ServiceWorkerHandlers,
): Promise<ServiceWorkerControls | null> {
  listeners.add(handlers);
  // Replayed for a late listener (StrictMode remount), after the caller has wired it up.
  if (needsRefresh) {
    queueMicrotask(() => {
      if (listeners.has(handlers)) handlers.onNeedRefresh();
    });
  }
  registration ??= register();
  return registration;
}

export function unregisterServiceWorkerHandlers(handlers: ServiceWorkerHandlers): void {
  listeners.delete(handlers);
}

async function register(): Promise<ServiceWorkerControls | null> {
  if (!serviceWorkerEnabled()) return null;
  const { registerSW } = await import('virtual:pwa-register');
  return new Promise((resolve) => {
    let current: ServiceWorkerRegistration | undefined;
    const hasWaiting = () => Boolean(current?.waiting);
    const check = async (): Promise<UpdateCheckResult> => {
      if (!current || !navigator.onLine) return 'unknown';
      try {
        await current.update();
      } catch {
        return 'unknown';
      }
      return current.installing || current.waiting ? 'found' : 'current';
    };
    const update = registerSW({
      immediate: true,
      onNeedRefresh: () => {
        needsRefresh = true;
        for (const listener of listeners) listener.onNeedRefresh();
      },
      // Without it the plugin reloads every tab as soon as any tab activates the new worker,
      // even one with a focused editor (FR-PWA-6).
      onNeedReload: () => {
        for (const listener of listeners) listener.onControllerChange();
      },
      onRegisteredSW: (_url, r) => {
        current = r;
        if (!r) return resolve(null);
        setInterval(() => void check(), hourlyMs);
        resolve({ apply: () => void update(true), hasWaiting, check });
      },
      onRegisterError: (error: unknown) => {
        console.warn('rooster: service worker failed', error);
        resolve(null);
      },
    });
  });
}
