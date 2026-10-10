/**
 * The notification preference matrix (FR-NOT-4, 05 §3 `notification_pref`): which cells exist
 * and what they default to. Zod-free, so the web's settings route and the server share it
 * without pulling zod into the initial bundle (10 §4). ADR 0033 records the defaults.
 */

export const NOTIFICATION_EVENT_TYPES = [
  'assigned',
  'comment',
  'mention',
  'completed',
  'due_changed',
  'invite_accepted',
  /** P10 (FR-REM-3): "Task reminders". The one type sent for the user's own actions. */
  'reminder',
] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

/** Rows of the matrix: every event, plus the daily digest and the due reminder (P7). */
export const NOTIFICATION_PREF_TYPES = [
  ...NOTIFICATION_EVENT_TYPES,
  'digest',
  'due_reminder',
] as const;
export type NotificationPrefType = (typeof NOTIFICATION_PREF_TYPES)[number];

export const NOTIFICATION_PREF_CHANNELS = ['inapp', 'push', 'email'] as const;
export type NotificationPrefChannel = (typeof NOTIFICATION_PREF_CHANNELS)[number];

/**
 * Whether a (type, channel) cell exists. Events go to every channel; the digest is an email
 * (FR-NOT-3) and the due reminder a push (FR-NOT-2).
 */
export function isPrefCell(type: NotificationPrefType, channel: NotificationPrefChannel): boolean {
  if (type === 'digest') return channel === 'email';
  if (type === 'due_reminder') return channel === 'push';
  return true;
}

/** Every cell, in matrix order (rows by type, then inapp · push · email). */
export const NOTIFICATION_PREF_CELLS: readonly {
  type: NotificationPrefType;
  channel: NotificationPrefChannel;
}[] = NOTIFICATION_PREF_TYPES.flatMap((type) =>
  NOTIFICATION_PREF_CHANNELS.filter((channel) => isPrefCell(type, channel)).map((channel) => ({
    type,
    channel,
  })),
);

/**
 * The default of a cell without a stored row (ADR 0033): in-app and push on for every event
 * (push still needs a subscribed device), email on only for assignments and mentions, and the
 * digest and the due reminder off until the user turns them on.
 */
export function defaultPrefEnabled(
  type: NotificationPrefType,
  channel: NotificationPrefChannel,
): boolean {
  if (!isPrefCell(type, channel)) return false;
  if (type === 'digest' || type === 'due_reminder') return false;
  if (channel === 'email') return type === 'assigned' || type === 'mention';
  return true;
}
