import { z } from 'zod';
import {
  dateFormatSchema,
  localeSchema,
  timeFormatSchema,
  timeSchema,
  timestampSchema,
  weekStartSchema,
} from './common.ts';
import { orgSchema } from './org.ts';
import { nameSchema } from './text.ts';

// IANA names only: `Area/Location`, plus the bare `UTC`. Offsets such as "+01:00" are
// rejected even though newer Intl implementations accept them.
const IANA_SHAPE = /^(?:UTC|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+)$/;

/** True for an IANA timezone name the runtime knows, e.g. `Europe/Stockholm`. */
export function isValidTimeZone(value: string): boolean {
  if (!IANA_SHAPE.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const timeZoneSchema = z
  .string()
  .refine(isValidTimeZone, { error: 'Expected an IANA timezone such as Europe/Stockholm' });

import { DEFAULT_PREFS, SWIPE_ACTIONS } from '../limits.ts';

export { DEFAULT_PREFS, SWIPE_ACTIONS } from '../limits.ts';
export const swipeActionSchema = z.enum(SWIPE_ACTIONS);

/** `user.prefs` (05 §2). Every key is optional in storage; reads apply `DEFAULT_PREFS`. */
export const prefsSchema = z.object({
  parseTitleDates: z.boolean(),
  /** How long a completed task stays visible before it fades out (D-09). */
  completeHideMs: z.int().min(0).max(10_000),
  swipeLeft: swipeActionSchema,
  swipeRight: swipeActionSchema,
  reminderTime: timeSchema,
  digestTime: timeSchema,
});

export const prefsPatchSchema = prefsSchema.partial();

/** Stored prefs merged over the defaults; unknown or invalid stored keys are dropped. */
export function resolvePrefs(stored: unknown): Prefs {
  const out: Record<string, unknown> = { ...DEFAULT_PREFS };
  if (stored !== null && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const [key, value] of Object.entries(stored)) {
      if (!Object.hasOwn(prefsSchema.shape, key)) continue;
      if (prefsSchema.shape[key as keyof Prefs].safeParse(value).success) out[key] = value;
    }
  }
  return out as Prefs;
}

/** GET /me: the signed-in user, their settings, their orgs in sidebar order and `isAdmin`. */
export const meSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  image: z.string().nullable(),
  locale: localeSchema,
  timezone: z.string(),
  weekStart: weekStartSchema,
  dateFormat: dateFormatSchema,
  timeFormat: timeFormatSchema,
  prefs: prefsSchema,
  isAdmin: z.boolean(),
  orgs: z.array(orgSchema),
});

export const mePatchSchema = z.object({
  name: nameSchema(80).optional(),
  locale: localeSchema.optional(),
  timezone: timeZoneSchema.optional(),
  weekStart: weekStartSchema.optional(),
  dateFormat: dateFormatSchema.optional(),
  timeFormat: timeFormatSchema.optional(),
  prefs: prefsPatchSchema.optional(),
});

/** A signed-in browser or device (Settings → Security). */
export const sessionSchema = z.object({
  id: z.string(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  expiresAt: timestampSchema,
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  /** The session making this request. */
  current: z.boolean(),
});

export type Prefs = z.infer<typeof prefsSchema>;
export type PrefsPatch = z.infer<typeof prefsPatchSchema>;
export type SwipeAction = z.infer<typeof swipeActionSchema>;
export type Me = z.infer<typeof meSchema>;
export type MePatch = z.infer<typeof mePatchSchema>;
export type Session = z.infer<typeof sessionSchema>;
