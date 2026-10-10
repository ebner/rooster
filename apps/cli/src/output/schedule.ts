import {
  describeRule,
  type RecurrenceBasis,
  WEEKDAYS,
  type Weekday,
} from '@rooster/core/recurrence';
import { namespaceTranslator } from '../i18n.ts';
import { type DateContext, dayLabel, instantLabel } from './format.ts';

/**
 * Repeat rules, reminders and file sizes as text (P10), in the viewer's language. The sentences
 * are the web's (`dates:repeat.rule.*`, `dates:reminder.*`), so the terminal and the pane say
 * the same thing.
 */

/** The weekday's name as the web writes it: `weekday.long.<n>` counts from Sunday. */
function weekdayName(weekday: Weekday, t: (key: string) => string): string {
  return t(`weekday.long.${(WEEKDAYS.indexOf(weekday) + 1) % 7}`);
}

/**
 * "Weekly on Monday", "3 days after completion, 4 times", "Den sista fredagen varje månad".
 * An unreadable rule (from a newer server) is shown as it is stored.
 */
export function ruleText(
  rule: string,
  basis: RecurrenceBasis | null | undefined,
  ctx: DateContext,
): string {
  const d = describeRule(rule, basis ?? 'due');
  if (d === null) return rule;
  const t = namespaceTranslator(ctx.locale, 'dates');
  const count = d.interval;
  let body: string;
  if (d.basis === 'completion') body = t(`repeat.rule.after.${d.freq}`, { count });
  else if (d.freq === 'DAILY') body = t('repeat.rule.daily', { count });
  else if (d.freq === 'WEEKLY') {
    const list = new Intl.ListFormat(ctx.locale, { type: 'conjunction' });
    body = d.everyWeekday
      ? t('repeat.rule.weekdays')
      : t('repeat.rule.weekly', {
          count,
          days: list.format((d.weekdays ?? []).map((w) => weekdayName(w, t))),
        });
  } else if (d.freq === 'MONTHLY') {
    body = d.nthWeekday
      ? t('repeat.rule.monthlyNth', {
          count,
          nth: t(d.nthWeekday.nth === -1 ? 'repeat.nth.last' : `repeat.nth.${d.nthWeekday.nth}`),
          weekday: weekdayName(d.nthWeekday.weekday, t),
        })
      : t('repeat.rule.monthlyDay', {
          count,
          day: t('repeat.ordinalDay', { day: d.monthDay ?? 1 }),
        });
  } else {
    const monthFirst = ctx.locale === 'en' && ctx.dateFormat === 'MMM d';
    body = t('repeat.rule.yearly', {
      count,
      date: t(monthFirst ? 'repeat.monthDay.monthFirst' : 'repeat.monthDay.dayFirst', {
        month: t(`month.short.${d.month ?? 1}`),
        day: d.monthDay ?? 1,
      }),
    });
  }
  if (d.end.kind === 'count') return t('repeat.rule.endCount', { rule: body, count: d.end.count });
  if (d.end.kind === 'until') {
    return t('repeat.rule.endUntil', { rule: body, date: dayLabel(d.end.until, ctx) });
  }
  return body;
}

/** "15 min before", "1 h before", "2 days before"; 0 is the due moment itself. */
export function offsetText(offsetMinutes: number, allDay: boolean, ctx: DateContext): string {
  const t = namespaceTranslator(ctx.locale, 'dates');
  if (offsetMinutes === 0) return t(allDay ? 'reminder.onTheDay' : 'reminder.atDue');
  if (offsetMinutes % 1440 === 0) return t('reminder.daysBefore', { count: offsetMinutes / 1440 });
  if (offsetMinutes % 60 === 0) return t('reminder.hoursBefore', { count: offsetMinutes / 60 });
  return t('reminder.minutesBefore', { count: offsetMinutes });
}

export interface ReminderLike {
  kind: 'relative' | 'absolute';
  offsetMinutes: number | null;
  fireAt: number | null;
  firedAt: number | null;
}

/**
 * "1 h before · Fri 13:00", "1 h before · needs a due date" (dormant: the task lost its due
 * date; ADR 0049 §2.2), "Fri 14:00", with "(sent)" once it has fired.
 */
export function reminderText(
  reminder: ReminderLike,
  task: { dueTime: string | null },
  ctx: DateContext,
): { text: string; dormant: boolean; fired: boolean } {
  const t = namespaceTranslator(ctx.locale, 'dates');
  const dormant = reminder.fireAt === null;
  const when = dormant ? t('reminder.dormant') : instantLabel(reminder.fireAt as number, ctx);
  const offset =
    reminder.kind === 'relative' && reminder.offsetMinutes !== null
      ? offsetText(reminder.offsetMinutes, task.dueTime === null, ctx)
      : null;
  const text = offset === null ? when : t('reminder.chip', { offset, when });
  const fired = reminder.firedAt !== null;
  return { text: fired ? `${text} ${t('reminder.firedSr')}` : text, dormant, fired };
}

const UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const;

/** "512 byte", "12 kB", "3.4 MB" in the viewer's number format (1 kB = 1024 bytes, as the web). */
export function sizeText(bytes: number, locale: string): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: UNITS[unit],
    unitDisplay: 'short',
    maximumFractionDigits: unit === 0 || value >= 10 ? 0 : 1,
  }).format(value);
}
