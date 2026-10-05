import { type DateFormat, formatRelative, type TimeFormat, todayIn } from '@rooster/core/dates';
import type { Locale } from '@rooster/i18n';

/** What a screen needs to render instants for the viewer (04 §8). */
export interface DisplayPrefs {
  locale: Locale;
  timezone: string;
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
}

/**
 * The calendar day of an instant in the viewer's timezone, labelled like due dates
 * ("Today", "Fri", "Oct 12"), so every date in the app reads the same way.
 */
export function formatDay(instant: number, prefs: DisplayPrefs, now: number): string {
  return formatRelative(
    { dueDate: todayIn(prefs.timezone, instant) },
    {
      today: todayIn(prefs.timezone, now),
      locale: prefs.locale,
      dateFormat: prefs.dateFormat,
      timeFormat: prefs.timeFormat,
    },
  );
}

const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['week', 7 * 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
];

/** "5 minutes ago", "yesterday", "just now" (under a minute) in the UI language. */
export function formatTimeAgo(
  instant: number,
  now: number,
  locale: Locale,
  justNow: string,
): string {
  const elapsed = now - instant;
  if (elapsed < 60 * 1000) return justNow;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, ms] of units) {
    if (elapsed >= ms) return format.format(-Math.floor(elapsed / ms), unit);
  }
  return justNow;
}
