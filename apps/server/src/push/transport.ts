import webpush from 'web-push';

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface VapidDetails {
  subject: string;
  publicKey: string;
  privateKey: string;
}

export interface PushSendOptions {
  /** Seconds the push service keeps an undelivered message. */
  ttl: number;
  urgency: 'very-low' | 'low' | 'normal' | 'high';
  vapid: VapidDetails;
}

/**
 * Sends one encrypted push message. Resolves once the push service accepted it; rejects with
 * an error carrying `statusCode` when it refused it (404/410: the subscription is gone).
 * Tests inject a fake.
 */
export type PushSender = (
  target: PushTarget,
  payload: string,
  options: PushSendOptions,
) => Promise<void>;

/** A stalled push service must not pin a delivery slot. */
const PUSH_TIMEOUT_MS = 15_000;

/**
 * `web-push` over `https.request`, which never follows redirects: a push service can only
 * answer, not bounce the request to another host (04 §4.11).
 */
export const webPushSender: PushSender = async (target, payload, options) => {
  await webpush.sendNotification(target, payload, {
    TTL: options.ttl,
    urgency: options.urgency,
    vapidDetails: options.vapid,
    timeout: PUSH_TIMEOUT_MS,
    contentEncoding: 'aes128gcm',
  });
};

export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  return webpush.generateVAPIDKeys();
}

/** The HTTP status a push service refused a message with, if the error carries one. */
export function pushStatusOf(err: unknown): number | null {
  if (err === null || typeof err !== 'object') return null;
  const status = (err as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' ? status : null;
}
