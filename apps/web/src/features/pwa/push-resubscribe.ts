/**
 * `pushsubscriptionchange` in the service worker (04 §6.3): the push service replaced or
 * expired this browser's subscription. Subscribes again with the same VAPID key and registers
 * the new endpoint, so push keeps working without the app being opened. The worker has no
 * API client (bundle size), so this is a plain same-origin POST with the session cookie.
 */

export interface SubscriptionChange {
  oldSubscription: Pick<PushSubscription, 'options'> | null;
  newSubscription: Pick<PushSubscription, 'toJSON'> | null;
}

export async function resubscribeAfterChange(
  change: SubscriptionChange,
  pushManager: Pick<PushManager, 'subscribe'>,
  post: (body: string) => Promise<unknown>,
  userAgent: string,
): Promise<boolean> {
  const key = change.oldSubscription?.options.applicationServerKey ?? null;
  const subscription =
    change.newSubscription ??
    (key
      ? await pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
      : null);
  if (!subscription) return false;
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return false;
  await post(
    JSON.stringify({
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      userAgent: userAgent.slice(0, 256),
    }),
  );
  return true;
}
