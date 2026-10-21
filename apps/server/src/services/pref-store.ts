import {
  defaultPrefEnabled,
  NOTIFICATION_PREF_CELLS,
  type NotificationPrefChannel,
  type NotificationPrefType,
} from '@rooster/core/notification-prefs';
import type { NotificationPref, Prefs } from '@rooster/core/schemas';
import { resolvePrefs } from '@rooster/core/schemas';
import type { Locale } from '@rooster/i18n/core';
import { isLocale } from '@rooster/i18n/core';
import { and, eq, isNull } from 'drizzle-orm';
import { notificationPref, user } from '../db/schema/index.ts';
import type { Tx } from './context.ts';

/**
 * Whether a cell of the user's matrix is on: their stored row, else the default (ADR 0033).
 * The `device_connected` security notice (11 §9.4) is outside the matrix: always in-app and by
 * email, never pushed.
 */
export function prefEnabled(
  tx: Tx,
  userId: string,
  type: NotificationPrefType | 'device_connected',
  channel: NotificationPrefChannel,
): boolean {
  if (type === 'device_connected') return channel !== 'push';
  const row = tx
    .select({ enabled: notificationPref.enabled })
    .from(notificationPref)
    .where(
      and(
        eq(notificationPref.userId, userId),
        eq(notificationPref.type, type),
        eq(notificationPref.channel, channel),
      ),
    )
    .get();
  return row?.enabled ?? defaultPrefEnabled(type, channel);
}

/** Every cell of the matrix, in matrix order, with defaults applied. */
export function prefMatrix(tx: Tx, userId: string): NotificationPref[] {
  const stored = new Map(
    tx
      .select()
      .from(notificationPref)
      .where(eq(notificationPref.userId, userId))
      .all()
      .map((r) => [`${r.type}/${r.channel}`, r.enabled]),
  );
  return NOTIFICATION_PREF_CELLS.map(({ type, channel }) => ({
    type,
    channel,
    enabled: stored.get(`${type}/${channel}`) ?? defaultPrefEnabled(type, channel),
  }));
}

/** Stores one cell. Rows exist only for cells a user changed; the rest follow the defaults. */
export function setPref(
  tx: Tx,
  userId: string,
  type: NotificationPrefType,
  channel: NotificationPrefChannel,
  enabled: boolean,
): void {
  tx.insert(notificationPref)
    .values({ userId, type, channel, enabled })
    .onConflictDoUpdate({
      target: [notificationPref.userId, notificationPref.type, notificationPref.channel],
      set: { enabled },
    })
    .run();
}

/** What delivery needs to know about a recipient. */
export interface Recipient {
  id: string;
  name: string;
  email: string;
  locale: Locale;
  timezone: string;
  dateFormat: string;
  timeFormat: string;
  prefs: Prefs;
}

type UserRow = typeof user.$inferSelect;

function parsePrefs(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

export function toRecipient(row: UserRow): Recipient {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    locale: isLocale(row.locale) ? row.locale : 'en',
    timezone: row.timezone,
    dateFormat: row.dateFormat,
    timeFormat: row.timeFormat,
    prefs: resolvePrefs(parsePrefs(row.prefs)),
  };
}

/** An enabled user with a verified email, or null: disabled users get nothing delivered. */
export function loadRecipient(tx: Tx, userId: string): Recipient | null {
  const row = tx
    .select()
    .from(user)
    .where(and(eq(user.id, userId), isNull(user.disabledAt)))
    .get();
  return row === undefined || !row.emailVerified ? null : toRecipient(row);
}

/**
 * Enabled users whose `(type, channel)` cell is on. With an off-by-default cell (the digest,
 * the due reminder) that is exactly the users with a stored enabled row.
 */
export function recipientsWithPref(
  tx: Tx,
  type: NotificationPrefType,
  channel: NotificationPrefChannel,
): Recipient[] {
  if (defaultPrefEnabled(type, channel)) {
    return tx
      .select()
      .from(user)
      .where(and(isNull(user.disabledAt), eq(user.emailVerified, true)))
      .all()
      .filter((row) => prefEnabled(tx, row.id, type, channel))
      .map(toRecipient);
  }
  return tx
    .select({ user })
    .from(notificationPref)
    .innerJoin(user, eq(user.id, notificationPref.userId))
    .where(
      and(
        eq(notificationPref.type, type),
        eq(notificationPref.channel, channel),
        eq(notificationPref.enabled, true),
        isNull(user.disabledAt),
        eq(user.emailVerified, true),
      ),
    )
    .all()
    .map((r) => toRecipient(r.user));
}
