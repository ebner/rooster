import {
  describeRule,
  type RecurrenceBasis,
  WEEKDAYS,
  type Weekday,
} from '@rooster/core/recurrence';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useDateText } from './date-text';
import type { ViewerDateContext } from './types';

/** `weekday.long.<n>` counts from Sunday; RFC 5545 weekdays from Monday. */
const sundayIndex = (weekday: Weekday) => (WEEKDAYS.indexOf(weekday) + 1) % 7;

export type RuleText = (rule: string, basis?: RecurrenceBasis | null) => string;

/**
 * "Weekly on Monday and Thursday", "Den sista fredagen varje månad", "3 days after completion,
 * 4 times": a stored rule (core `describeRule`) in the viewer's language. An unparsable rule
 * reads as an empty string.
 */
export function useRuleText(
  ctx: Pick<ViewerDateContext, 'locale' | 'dateFormat' | 'timeFormat' | 'today'>,
): RuleText {
  const { t } = useTranslation('dates', { lng: ctx.locale });
  const text = useDateText(ctx);
  return useMemo(() => {
    const list = new Intl.ListFormat(ctx.locale, { type: 'conjunction' });
    const monthFirst = ctx.locale === 'en' && ctx.dateFormat === 'MMM d';
    return (rule, basis) => {
      const d = describeRule(rule, basis ?? 'due');
      if (!d) return '';
      const count = d.interval;
      let body: string;
      if (d.basis === 'completion') {
        body = t(`repeat.rule.after.${d.freq}` as 'repeat.rule.after.DAILY', { count });
      } else if (d.freq === 'DAILY') {
        body = t('repeat.rule.daily', { count });
      } else if (d.freq === 'WEEKLY') {
        body = d.everyWeekday
          ? t('repeat.rule.weekdays')
          : t('repeat.rule.weekly', {
              count,
              days: list.format((d.weekdays ?? []).map((w) => text.weekdayLong(sundayIndex(w)))),
            });
      } else if (d.freq === 'MONTHLY') {
        body = d.nthWeekday
          ? t('repeat.rule.monthlyNth', {
              count,
              nth: t(
                (d.nthWeekday.nth === -1
                  ? 'repeat.nth.last'
                  : `repeat.nth.${d.nthWeekday.nth}`) as 'repeat.nth.1',
              ),
              weekday: text.weekdayLong(sundayIndex(d.nthWeekday.weekday)),
            })
          : t('repeat.rule.monthlyDay', {
              count,
              day: t('repeat.ordinalDay', { day: d.monthDay ?? 1 }),
            });
      } else {
        const month = t(`month.short.${d.month ?? 1}` as 'month.short.1');
        body = t('repeat.rule.yearly', {
          count,
          date: t(monthFirst ? 'repeat.monthDay.monthFirst' : 'repeat.monthDay.dayFirst', {
            month,
            day: d.monthDay ?? 1,
          }),
        });
      }
      if (d.end.kind === 'count')
        return t('repeat.rule.endCount', { rule: body, count: d.end.count });
      if (d.end.kind === 'until') {
        return t('repeat.rule.endUntil', { rule: body, date: text.short(d.end.until) });
      }
      return body;
    };
  }, [t, text, ctx.locale, ctx.dateFormat]);
}
