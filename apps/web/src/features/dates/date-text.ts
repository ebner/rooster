import {
  dueInstant,
  formatTime,
  type IsoDate,
  parseIsoDate,
  todayIn,
  weekdayOf,
} from '@rooster/core/dates';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { DueValue, ViewerDateContext } from './types';

/** A due date and time as the viewer sees them (times converted to the viewer's zone). */
export interface LocalDue {
  date: IsoDate;
  time: string | null;
}

const hhmmFormatters = new Map<string, Intl.DateTimeFormat>();

/** `HH:MM` of an instant in `timeZone` (24 h, zero-padded). */
function hhmmIn(timeZone: string, instant: number): string {
  let formatter = hhmmFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    hhmmFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(instant);
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${hour}:${minute}`;
}

/**
 * The due as the viewer sees it. Floating dates stay as they are; a timed due set in
 * another zone is moved to the viewer's zone first (ADR 0001 §5), which can shift its date.
 */
export function toLocalDue(value: DueValue, timezone: string): LocalDue | null {
  if (!value.dueDate) return null;
  if (!value.dueTime) return { date: value.dueDate, time: null };
  if (!value.dueTz || value.dueTz === timezone) return { date: value.dueDate, time: value.dueTime };
  const instant = dueInstant(value.dueDate, value.dueTime, value.dueTz);
  return { date: todayIn(timezone, instant), time: hhmmIn(timezone, instant) };
}

/** The stored value for a picked local date and time; times carry the viewer's zone. */
export function toDueValue(local: LocalDue, timezone: string): DueValue {
  return { dueDate: local.date, dueTime: local.time, dueTz: local.time ? timezone : null };
}

export interface DateText {
  /** "Friday, 10 October 2026, 14:00" (tooltips, accessible names; 02 §8.3). */
  full: (date: IsoDate, time?: string | null) => string;
  /** "Fri, Oct 10" (the picker preview); the year only when it is not this year. */
  short: (date: IsoDate, time?: string | null) => string;
  /** "Friday, 10 October 2026 – Monday, 12 October 2026". */
  range: (start: string, end: string) => string;
  /** "October 2026" (calendar header). */
  monthYear: (year: number, month: number) => string;
  /** Column header ("Mo") and its full name ("Monday"). */
  weekdayNarrow: (weekday: number) => string;
  weekdayLong: (weekday: number) => string;
}

/**
 * Long-form date text for the viewer's language and date format. Names come from the
 * `dates` catalog rather than `Intl` so web output matches the other clients (ADR 0001).
 */
export function useDateText(
  ctx: Pick<ViewerDateContext, 'locale' | 'dateFormat' | 'timeFormat' | 'today'>,
): DateText {
  const { t } = useTranslation('dates', { lng: ctx.locale });
  return useMemo(() => {
    const monthFirst = ctx.locale === 'en' && ctx.dateFormat === 'MMM d';
    const withTime = (date: string, time: string | null | undefined) =>
      time
        ? t('format.withTime', { date, time: formatTime(time, ctx.locale, ctx.timeFormat) })
        : date;
    const weekdayLong = (weekday: number) => t(`weekday.long.${weekday}` as 'weekday.long.0');
    return {
      full: (date, time) => {
        const { year, month, day } = parseIsoDate(date);
        const args = {
          weekday: weekdayLong(weekdayOf(date)),
          month: t(`month.long.${month}` as 'month.long.1'),
          day,
          year: String(year),
        };
        return withTime(
          t(monthFirst ? 'format.full.monthFirst' : 'format.full.dayFirst', args),
          time,
        );
      },
      short: (date, time) => {
        const { year, month, day } = parseIsoDate(date);
        const args = {
          weekday: t(`weekday.short.${weekdayOf(date)}` as 'weekday.short.0'),
          month: t(`month.short.${month}` as 'month.short.1'),
          day,
          year: String(year),
        };
        const sameYear = year === parseIsoDate(ctx.today).year;
        const key = monthFirst
          ? sameYear
            ? 'format.short.monthFirst'
            : 'format.short.monthFirstYear'
          : sameYear
            ? 'format.short.dayFirst'
            : 'format.short.dayFirstYear';
        return withTime(t(key, args), time);
      },
      range: (start, end) => t('format.range', { start, end }),
      monthYear: (year, month) =>
        t('calendar.monthYear', {
          month: t(`month.long.${month}` as 'month.long.1'),
          year: String(year),
        }),
      weekdayNarrow: (weekday) => t(`weekday.narrow.${weekday}` as 'weekday.narrow.0'),
      weekdayLong,
    };
  }, [t, ctx.locale, ctx.dateFormat, ctx.timeFormat, ctx.today]);
}
