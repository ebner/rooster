import {
  addDays,
  diffDays,
  formatRelative,
  type IsoDate,
  parseIsoDate,
  weekdayOf,
} from '@rooster/core/dates';
import type { ViewSectionKind } from '@rooster/core/views';
import type { ViewerDateContext } from '../dates';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * "Oct 8" / "8 okt" in the viewer's date format: the absolute label `formatRelative` gives a
 * date a week away from "today" in the same year, so the wording matches the date cells.
 */
export function dayMonthLabel(date: IsoDate, ctx: ViewerDateContext): string {
  const { month, day } = parseIsoDate(date);
  const anchor = month === 12 && day > 24 ? addDays(date, -7) : addDays(date, 7);
  return formatRelative(
    { dueDate: date },
    { today: anchor, locale: ctx.locale, dateFormat: ctx.dateFormat, timeFormat: ctx.timeFormat },
  );
}

/**
 * A smart-view section header (02 §10): Overdue, then the date ("Thursday, Oct 9") in Today,
 * whose page title already says "Today"; Today, Tomorrow, then "Wednesday, Oct 8" in Next 7
 * days. `t` is the `views` namespace.
 */
export function sectionLabel(
  t: Translate,
  kind: ViewSectionKind,
  date: IsoDate | null,
  ctx: ViewerDateContext,
): string {
  if (kind === 'overdue') return t('section.overdue');
  if (kind === 'today') return dayLabel(t, date ?? ctx.today, ctx);
  if (kind === 'flat' || !date) return t('section.today');
  const days = diffDays(date, ctx.today);
  if (days === 0) return t('section.today');
  if (days === 1) return t('section.tomorrow');
  return dayLabel(t, date, ctx);
}

function dayLabel(t: Translate, date: IsoDate, ctx: ViewerDateContext): string {
  return t('section.day', {
    weekday: t(`weekday.${weekdayOf(date)}`),
    date: dayMonthLabel(date, ctx),
  });
}
