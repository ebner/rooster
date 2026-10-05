export interface ServiceWorkerControls {
  /** Activates the waiting worker (`SKIP_WAITING`); the page reloads once it takes control. */
  apply(): void;
  /** Asks the browser to look for a new `sw.js` now (SSE `hello`, foreground, hourly). */
  check(): void;
}

/** Off in `vite` dev (stale workers there only get in the way) unless VITE_PWA_DEV=1. */
export function serviceWorkerEnabled(): boolean {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;
  return import.meta.env.PROD || import.meta.env.VITE_PWA_DEV === '1';
}

const hourlyMs = 60 * 60 * 1000;

let registration: Promise<ServiceWorkerControls | null> | null = null;
const refreshListeners = new Set<() => void>();
let needsRefresh = false;

/**
 * Registers `sw.js` through workbox-window (vite-plugin-pwa's `registerType: 'prompt'`): a new
 * version waits until the user chooses to reload (FR-PWA-6, 04 §6.3). Registers once per page;
 * later calls share it (StrictMode mounts effects twice).
 */
export function registerServiceWorker(handlers: {
  onNeedRefresh: () => void;
}): Promise<ServiceWorkerControls | null> {
  refreshListeners.add(handlers.onNeedRefresh);
  if (needsRefresh) handlers.onNeedRefresh();
  registration ??= register();
  return registration;
}

export function unregisterRefreshListener(listener: () => void): void {
  refreshListeners.delete(listener);
}

async function register(): Promise<ServiceWorkerControls | null> {
  if (!serviceWorkerEnabled()) return null;
  const { registerSW } = await import('virtual:pwa-register');
  let current: ServiceWorkerRegistration | undefined;
  const update = registerSW({
    immediate: true,
    onNeedRefresh: () => {
      needsRefresh = true;
      for (const listener of refreshListeners) listener();
    },
    onRegisteredSW: (_url, r) => {
      current = r;
    },
    onRegisterError: (error: unknown) => console.warn('rooster: service worker failed', error),
  });
  const check = () => {
    if (current && navigator.onLine) void current.update().catch(() => {});
  };
  setInterval(check, hourlyMs);
  return { apply: () => void update(true), check };
}
