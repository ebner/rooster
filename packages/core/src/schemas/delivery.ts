import { z } from 'zod';
import { idSchema, timestampSchema } from './common.ts';

/**
 * Phase 7 notification delivery contract (01 FR-NOT-2/3/4, 05 §3 `push_subscription` and
 * `notification_pref`, 06 §2.6). DTOs are additive-only within API v1.
 */

// ---------------------------------------------------------------------------------------------
// Web Push
// ---------------------------------------------------------------------------------------------

/** GET /push/vapid-public-key. 404 `push_disabled` never happens: keys are generated at boot. */
export const vapidPublicKeySchema = z.object({ publicKey: z.string().min(1) });

/**
 * POST /me/push-subscriptions: `PushSubscription.toJSON()` from the browser plus a device
 * label. Upserts by `endpoint` (re-subscribing the same browser updates its keys and owner).
 */
export const pushSubscriptionCreateSchema = z.object({
  endpoint: z.url({ protocol: /^https$/ }).max(2048),
  keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(64) }),
  /** A readable device label, e.g. "Chrome on Android"; the server falls back to its UA. */
  userAgent: z.string().max(256).optional(),
});

/** One of the user's subscribed devices (Settings → Notifications). */
export const pushSubscriptionSchema = z.object({
  id: idSchema,
  userAgent: z.string().nullable(),
  createdAt: timestampSchema,
  /** The last push the push service accepted; null before the first. */
  lastOkAt: timestampSchema.nullable(),
});

export const pushSubscriptionListSchema = z.array(pushSubscriptionSchema);

/**
 * The JSON body of every push message. The service worker (`apps/web/src/sw.ts`, `PushData`)
 * shows `title`/`body` as they are, so the server localises them in the recipient's locale.
 * `url` is a same-origin path (`/o/:slug/t/:taskId`, `/inbox`, `/o/:slug/today`).
 */
export const pushPayloadSchema = z.object({
  title: z.string(),
  body: z.string(),
  url: z.string().startsWith('/'),
  /** Collapses repeated notifications about the same thing (e.g. `task:<id>`, `reminder`). */
  tag: z.string().optional(),
  kind: z.enum(['notification', 'due_reminder', 'test']),
});

// ---------------------------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------------------------

/** FR-NOT-3: notification emails go out at once, or as one email per 15 minutes. */
export const EMAIL_MODES = ['immediate', 'batch'] as const;
export const emailModeSchema = z.enum(EMAIL_MODES);

/**
 * Unsubscribe categories (`GET/POST /unsubscribe/:token`): one notification type, or the
 * digest. The token is an HMAC over `{userId, category}` and never expires (06 §2.6).
 */
export const UNSUBSCRIBE_CATEGORIES = [
  'assigned',
  'comment',
  'mention',
  'completed',
  'due_changed',
  'invite_accepted',
  'digest',
] as const;
export const unsubscribeCategorySchema = z.enum(UNSUBSCRIBE_CATEGORIES);

export type VapidPublicKey = z.infer<typeof vapidPublicKeySchema>;
export type PushSubscriptionCreate = z.infer<typeof pushSubscriptionCreateSchema>;
export type PushSubscriptionInfo = z.infer<typeof pushSubscriptionSchema>;
export type PushPayload = z.infer<typeof pushPayloadSchema>;
export type EmailMode = z.infer<typeof emailModeSchema>;
export type UnsubscribeCategory = z.infer<typeof unsubscribeCategorySchema>;
