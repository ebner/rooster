import { isAllowedPushEndpoint } from '@rooster/core/push-hosts';
import type { PushSubscriptionInfo } from '@rooster/core/schemas';
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { pushMarkerPattern, unsubscribeThisBrowser } from '../features/pwa/push-local';
import { userStorageKey } from '../lib/user-storage';
import { ApiError } from './errors';
import { api, unwrap } from './http';
import { sessionScope } from './session-events';
import type { MutationResult, QueryResult } from './types';

/**
 * Web Push for this browser (FR-NOT-2, WP 7.1): the VAPID key, the user's subscribed devices,
 * and subscribing or unsubscribing this one. Loaded with Settings → Notifications and, after
 * the first paint, by `PwaRoot` to re-subscribe after a key rotation (08 §key rotation), so it
 * stays out of the initial bundle.
 */

export const pushKeys = {
  vapid: ['push', 'vapid'] as const,
  devices: ['push', 'devices'] as const,
  thisDevice: (userId: string, publicKey: string) =>
    ['push', 'this-device', userId, publicKey] as const,
};

/** The id of this browser's subscription on the server, per user (swept on sign-out). */
const deviceMarker = (userId: string) => userStorageKey(userId, 'pushDevice');
/**
 * The endpoint this page last registered for that device (canonical). The browser may replace
 * its subscription while no page is open; when the worker's renewal POST failed, this is the
 * endpoint the server still holds, and the next app open renews from it.
 */
const endpointMarker = (userId: string) => userStorageKey(userId, 'pushEndpoint');

function readMarker(userId: string): string | null {
  try {
    return localStorage.getItem(deviceMarker(userId));
  } catch {
    return null;
  }
}

function readEndpoint(userId: string): string | null {
  try {
    return localStorage.getItem(endpointMarker(userId));
  } catch {
    return null;
  }
}

/** `endpoint` null drops the opt-in here (both markers). */
function writeMarker(userId: string, id: string | null, endpoint: string | null = null): void {
  try {
    if (id === null) localStorage.removeItem(deviceMarker(userId));
    else localStorage.setItem(deviceMarker(userId), id);
    if (endpoint === null) localStorage.removeItem(endpointMarker(userId));
    else localStorage.setItem(endpointMarker(userId), endpoint);
  } catch {
    // Blocked storage: the device list still shows the subscription, only not as this one.
  }
}

/** The user ids that turned push on in this browser (normally one: others are swept). */
function markedUsers(): string[] {
  try {
    const users: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      const match = key ? pushMarkerPattern.exec(key) : null;
      if (match?.[1]) users.push(match[1]);
    }
    return users;
  } catch {
    return [];
  }
}

/**
 * The browser's push service is not one the server delivers to (ADR 0033: known Web Push
 * hosts only, against SSRF). Rare: an unusual browser or a self-hosted push service.
 */
export class UnsupportedPushServiceError extends Error {
  constructor() {
    super('unsupported push service');
    this.name = 'UnsupportedPushServiceError';
  }
}

/** A VAPID public key (base64url, 65 bytes uncompressed P-256) as the bytes `subscribe` takes. */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * Whether a subscription was made with this VAPID key. After an admin regenerates the keys
 * (08), every old subscription is useless: the push service rejects the new signature.
 */
export function sameApplicationServerKey(
  subscriptionKey: ArrayBuffer | null | undefined,
  publicKey: string,
): boolean {
  if (!subscriptionKey) return false;
  const a = new Uint8Array(subscriptionKey);
  const b = base64UrlToBytes(publicKey);
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** `POST /me/push-subscriptions`; `renewsEndpoint` makes it a renewal (no gesture). */
export interface SubscriptionBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent: string;
  renewsEndpoint?: string;
}

/** The server compares endpoints in their canonical form (`new URL(u).href`). */
export function canonicalEndpoint(endpoint: string): string {
  try {
    return new URL(endpoint).href;
  } catch {
    return endpoint;
  }
}

/** The POST body for a browser subscription; the server labels the device from its UA. */
export function subscriptionBody(
  subscription: Pick<PushSubscription, 'toJSON'>,
  userAgent: string,
  renewsEndpoint?: string,
): SubscriptionBody {
  const json = subscription.toJSON();
  return {
    endpoint: canonicalEndpoint(json.endpoint ?? ''),
    keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
    userAgent: userAgent.slice(0, 256),
    ...(renewsEndpoint ? { renewsEndpoint: canonicalEndpoint(renewsEndpoint) } : {}),
  };
}

/**
 * A renewal the server refused because the device is no longer this user's live subscription
 * (`410 push_gone`: removed elsewhere) or the new endpoint is another account's (`409`).
 */
export function isRenewalRefused(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 410 || error.status === 409);
}

/** `GET /push/vapid-public-key`. */
export function useVapidKey(enabled: boolean): QueryResult<string> {
  return useQuery({
    queryKey: pushKeys.vapid,
    queryFn: async () => (await unwrap(api.GET('/api/v1/push/vapid-public-key'))).publicKey,
    enabled,
    staleTime: 60_000,
  });
}

/** `GET /me/push-subscriptions`: the user's devices, with each one's last delivery. */
export function usePushDevices(enabled: boolean): QueryResult<PushSubscriptionInfo[]> {
  return useQuery({
    queryKey: pushKeys.devices,
    queryFn: () => unwrap(api.GET('/api/v1/me/push-subscriptions')),
    enabled,
  });
}

export interface ThisDevice {
  /** This browser holds a subscription made with the current key. */
  subscribed: boolean;
  /** Its id on the server, when this user turned it on here. */
  deviceId: string | null;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.ready;
}

/** This browser's push state for the user (only where a service worker and push exist). */
export function useThisDevice(
  userId: string | undefined,
  publicKey: string | undefined,
): QueryResult<ThisDevice> {
  return useQuery({
    queryKey: pushKeys.thisDevice(userId ?? '', publicKey ?? ''),
    queryFn: async (): Promise<ThisDevice> => {
      const subscription = await (await registration()).pushManager.getSubscription();
      const subscribed = sameApplicationServerKey(
        subscription?.options.applicationServerKey,
        publicKey ?? '',
      );
      return { subscribed, deviceId: subscribed ? readMarker(userId ?? '') : null };
    },
    enabled: Boolean(userId && publicKey),
    staleTime: 0,
  });
}

/** A push operation tied to the session it started in (ADR 0051). */
interface PushOperation {
  /** The session ended since the operation started. */
  stale(): boolean;
  /** The subscription the operation holds: dropped the moment the session's data clears. */
  hold(subscription: Pick<PushSubscription, 'unsubscribe'>): void;
  /** Settled: from here on the device marker (and the sweep) cover the subscription. */
  done(): void;
}

function pushOperation(): PushOperation {
  let held: Pick<PushSubscription, 'unsubscribe'> | null = null;
  // At once, not when the request settles: the response may never arrive (the tab closes),
  // and the sweep finds no marker for a registration still under way.
  const scope = sessionScope(() => {
    void held?.unsubscribe().catch(() => false);
  });
  return {
    stale: scope.stale,
    hold: (subscription) => {
      held = subscription;
    },
    done: scope.done,
  };
}

/**
 * Subscribes this browser with the current key and registers it with the server. A
 * subscription made with an older key is replaced first: `subscribe` refuses a different key
 * while one exists. `session` is the session the operation started in: when it ended meanwhile
 * (a 401, sign-out, another account), the sweep found no marker to unsubscribe for, so this
 * operation drops its subscription itself and writes no marker (ADR 0051).
 */
async function subscribeAndRegister(
  userId: string,
  publicKey: string,
  renewsEndpoint: string | undefined,
  session: PushOperation,
): Promise<string> {
  const reg = await registration();
  let subscription = await reg.pushManager.getSubscription();
  if (
    subscription &&
    !sameApplicationServerKey(subscription.options.applicationServerKey, publicKey)
  ) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToBytes(publicKey),
  });
  const held = subscription;
  session.hold(held);
  const abandon = async () => {
    await held.unsubscribe().catch(() => false);
    throw new ApiError('aborted', 0);
  };
  if (session.stale()) return abandon();
  const body = subscriptionBody(subscription, navigator.userAgent, renewsEndpoint);
  if (!isAllowedPushEndpoint(body.endpoint)) {
    await subscription.unsubscribe();
    throw new UnsupportedPushServiceError();
  }
  let device: PushSubscriptionInfo;
  try {
    device = await unwrap(api.POST('/api/v1/me/push-subscriptions', { body }));
  } catch (error) {
    if (session.stale()) return abandon();
    if (error instanceof ApiError && error.status === 422) {
      await subscription.unsubscribe();
      throw new UnsupportedPushServiceError();
    }
    throw error;
  }
  if (session.stale()) return abandon();
  writeMarker(userId, device.id, body.endpoint);
  return device.id;
}

export type EnablePushResult = 'on' | 'denied' | 'dismissed';

/**
 * "Turn on push for this device". Call it straight from the button's press handler: the
 * permission prompt needs the user's gesture (FR-NOT-2), so it is the first thing awaited.
 */
export async function enablePush(
  queryClient: QueryClient,
  userId: string,
  publicKey: string,
): Promise<EnablePushResult> {
  const session = pushOperation();
  try {
    const permission = await Notification.requestPermission();
    if (permission === 'denied') return 'denied';
    if (permission !== 'granted') return 'dismissed';
    try {
      await subscribeAndRegister(userId, publicKey, undefined, session);
    } finally {
      await queryClient.invalidateQueries({ queryKey: ['push'] });
    }
    return 'on';
  } finally {
    session.done();
  }
}

/** Turns push off here: removes the server's record and drops the browser subscription. */
export async function disablePush(queryClient: QueryClient, userId: string): Promise<void> {
  const deviceId = readMarker(userId);
  try {
    if (deviceId) {
      await unwrap(
        api.DELETE('/api/v1/me/push-subscriptions/{id}', { params: { path: { id: deviceId } } }),
      ).catch((error: unknown) => {
        // Already gone (removed elsewhere, or dropped after the push service refused it).
        if (!(error instanceof ApiError && error.status === 404)) throw error;
      });
    }
    const subscription = await (await registration()).pushManager.getSubscription();
    await subscription?.unsubscribe();
    writeMarker(userId, null);
  } finally {
    await queryClient.invalidateQueries({ queryKey: ['push'] });
  }
}

/**
 * `POST /me/push-subscriptions/:id/test`: a test notification to one device. The server waits
 * for the push service; a device it no longer knows is deleted there (`410 push_gone`), so
 * the list is refreshed after a failure.
 */
export function useSendTestPush(): MutationResult<string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await unwrap(
        api.POST('/api/v1/me/push-subscriptions/{id}/test', { params: { path: { id } } }),
      );
    },
    onError: () => queryClient.invalidateQueries({ queryKey: ['push'] }),
  });
}

/** `DELETE /me/push-subscriptions/:id`, optimistic. Removing this browser also drops it here. */
export function useRemovePushDevice(userId: string | undefined): MutationResult<string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      if (userId && readMarker(userId) === id) {
        await disablePush(queryClient, userId);
        return;
      }
      await unwrap(api.DELETE('/api/v1/me/push-subscriptions/{id}', { params: { path: { id } } }));
    },
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: pushKeys.devices });
      const before = queryClient.getQueryData<PushSubscriptionInfo[]>(pushKeys.devices);
      queryClient.setQueryData<PushSubscriptionInfo[]>(pushKeys.devices, (devices) =>
        devices?.filter((device) => device.id !== id),
      );
      return { before };
    },
    onError: (_error, _id, context) => {
      queryClient.setQueryData(pushKeys.devices, context?.before);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: pushKeys.devices }),
  });
}

/**
 * On app start (`PwaRoot`): where this user turned push on and the permission still stands,
 * keep the subscription on the current key and registered. After a key rotation this
 * re-subscribes silently (no prompt); after the browser replaced the subscription and the
 * worker could not register it (offline, 503), it registers the one the browser holds. Either
 * is a renewal of a subscription the server knows, so a device the user removed elsewhere
 * never comes back: the server answers `410`/`409`, and push goes off here too. A failure
 * (offline) leaves the markers, so the next open tries again.
 */
export async function resyncPush(): Promise<void> {
  const [userId] = markedUsers();
  if (!userId || Notification.permission !== 'granted') return;
  const session = pushOperation();
  try {
    await renewOnOpen(userId, session);
  } finally {
    session.done();
  }
}

async function renewOnOpen(userId: string, session: PushOperation): Promise<void> {
  const { publicKey } = await unwrap(api.GET('/api/v1/push/vapid-public-key'));
  const subscription = await (await registration()).pushManager.getSubscription();
  const held = subscription?.endpoint ? canonicalEndpoint(subscription.endpoint) : null;
  if (!held) {
    // Nothing to renew from (the browser or the worker dropped it): never subscribe anew
    // without the user's gesture.
    writeMarker(userId, null);
    return;
  }
  const registered = readEndpoint(userId);
  const sameKey = sameApplicationServerKey(subscription?.options.applicationServerKey, publicKey);
  if (sameKey && registered === held) return;
  // What the server may hold for this device: the endpoint the browser has (the worker
  // registered it, or nothing changed since a marker from before endpoints were kept), then
  // the one this page registered last (the worker's renewal never arrived).
  const candidates = registered === null || registered === held ? [held] : [held, registered];
  for (const renews of candidates) {
    try {
      await subscribeAndRegister(userId, publicKey, renews, session);
      return;
    } catch (error) {
      if (!isRenewalRefused(error)) throw error;
      // Taken by another account: no other candidate makes the endpoint this user's.
      if (error instanceof ApiError && error.status === 409) break;
    }
  }
  await unsubscribeThisBrowser();
  writeMarker(userId, null);
}

/**
 * Sign-out (call it while the session is still valid): removes this browser's device on the
 * server for every user who turned push on here, drops the browser subscription, then the
 * markers. On a shared browser the next person must not get this user's notifications. A
 * failed DELETE (offline) still unsubscribes locally; the server drops the dead endpoint on
 * the push service's next `404/410`.
 */
export async function forgetPushOnSignOut(): Promise<void> {
  const users = markedUsers();
  for (const userId of users) {
    const id = readMarker(userId);
    if (!id) continue;
    await unwrap(
      api.DELETE('/api/v1/me/push-subscriptions/{id}', { params: { path: { id } } }),
    ).catch(() => undefined);
  }
  await unsubscribeThisBrowser();
  for (const userId of users) writeMarker(userId, null);
}
