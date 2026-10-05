import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { type PushData, pushTargetPath } from './features/pwa/push-target';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: (string | { url: string; revision: string | null })[];
};

/**
 * The service worker (04 §6.3, injectManifest): precaches the app shell, fonts and icons,
 * answers navigations with the shell, and never touches the API. Updates wait for the page:
 * `skipWaiting` only runs when the user chose "Reload" and the outbox is empty (FR-PWA-6).
 */
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

/** Server-owned paths: never answered with the SPA shell. `/api/*` is never cached at all. */
const serverPaths = [/^\/api(\/|$)/, /^\/ical(\/|$)/, /^\/_dev(\/|$)/, /^\/(healthz|readyz)$/];

registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: serverPaths }),
);

self.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | null)?.type === 'SKIP_WAITING') void self.skipWaiting();
});

// P7 web push: the payload names the task; a click focuses an open window or opens one.
self.addEventListener('push', (event) => {
  let data: PushData = {};
  try {
    data = (event.data?.json() as PushData | undefined) ?? {};
  } catch {
    data = { body: event.data?.text() ?? '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title ?? 'rooster', {
      body: data.body ?? '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data,
      ...(data.tag ? { tag: data.tag } : {}),
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = pushTargetPath(event.notification.data, self.location.origin);
  event.waitUntil(focusOrOpen(new URL(path, self.location.origin).href));
});

async function focusOrOpen(url: string): Promise<void> {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
  if (open) {
    await open.focus();
    // The page routes in place (no reload); see `features/pwa/pwa-root.tsx`.
    open.postMessage({ type: 'rooster:navigate', path: new URL(url).pathname });
    return;
  }
  await self.clients.openWindow(url);
}
