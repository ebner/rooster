/**
 * Off in `vite` dev (stale workers there only get in the way) unless VITE_PWA_DEV=1. Apart
 * from `sw-registration.ts` so push code can ask without importing `virtual:pwa-register`.
 */
export function serviceWorkerEnabled(): boolean {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;
  return import.meta.env.PROD || import.meta.env.VITE_PWA_DEV === '1';
}
