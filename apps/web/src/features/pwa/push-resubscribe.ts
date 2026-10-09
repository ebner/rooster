/**
 * `pushsubscriptionchange` in the service worker (04 §6.3): the push service replaced or
 * expired this browser's subscription. Registers the new endpoint as a renewal of the old one
 * (`renewsEndpoint`), so push keeps working without the app being opened, but a device the
 * user removed elsewhere is never brought back: the server answers `410 push_gone` (or `409`
 * when the endpoint is another account's) and the new subscription is dropped here. Without
 * an old subscription there is nothing to renew from: no POST, and the new subscription is
 * dropped too (never left active and unregistered); the next app open turns push off. The
 * worker has no API client (bundle size), so this is a plain same-origin POST with the cookie.
 */

export interface SubscriptionChange {
  oldSubscription: Pick<PushSubscription, 'options' | 'endpoint'> | null;
  newSubscription: Pick<PushSubscription, 'toJSON' | 'unsubscribe'> | null;
}

export type RenewalResult = 'renewed' | 'skipped' | 'gone' | 'failed';

/** Endpoints are compared in canonical form on the server (`new URL(u).href`). */
function canonical(endpoint: string): string {
  try {
    return new URL(endpoint).href;
  } catch {
    return endpoint;
  }
}

export async function resubscribeAfterChange(
  change: SubscriptionChange,
  pushManager: Pick<PushManager, 'subscribe'>,
  post: (body: string) => Promise<Pick<Response, 'status' | 'ok'>>,
  userAgent: string,
): Promise<RenewalResult> {
  const old = change.oldSubscription;
  if (!old?.endpoint) {
    // Nothing proves which device this renews, so it is not registered; it must not stay
    // active either. The next app open finds no subscription, drops the marker, and Settings
    // shows push as off with "Turn on" to re-enable it.
    await change.newSubscription?.unsubscribe().catch(() => false);
    return 'skipped';
  }
  const key = old.options.applicationServerKey ?? null;
  const subscription =
    change.newSubscription ??
    (key
      ? await pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
      : null);
  if (!subscription) return 'skipped';
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return 'skipped';
  const response = await post(
    JSON.stringify({
      endpoint: canonical(json.endpoint),
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      userAgent: userAgent.slice(0, 256),
      renewsEndpoint: canonical(old.endpoint),
    }),
  );
  if (response.status === 410 || response.status === 409) {
    await subscription.unsubscribe().catch(() => false);
    return 'gone';
  }
  return response.ok ? 'renewed' : 'failed';
}
