import {
  type DateParts,
  diffDays,
  type IsoDate,
  parseIsoDate,
  parseTime,
  weekdayOf,
} from './iso.ts';

export const LOCALES = ['en', 'sv'] as const;
export const DATE_FORMATS = ['MMM d', 'd MMM'] as const;
export const TIME_FORMATS = ['24h', '12h'] as const;

export type Locale = (typeof LOCALES)[number];
export type DateFormat = (typeof DATE_FORMATS)[number];
export type TimeFormat = (typeof TIME_FORMATS)[number];

export interface RelativeInput {
  dueDate: IsoDate;
  /** `HH:MM`, already in the viewer's timezone. */
  dueTime?: string | null;
  startDate?: IsoDate | null;
}

export interface FormatContext {
  today: IsoDate;
  locale: Locale;
  /** English only; Swedish always uses `d MMM`. */
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
}

interface LocaleStrings {
  today: string;
  tomorrow: string;
  yesterday: string;
  weekdays: readonly [string, string, string, string, string, string, string];
  months: readonly string[];
  am: string;
  pm: string;
}

// Spelled out rather than taken from Intl so labels are identical across runtimes and ICU
// versions (web, TUI and emails must agree, and Intl inserts narrow no-break spaces in times).
const STRINGS: Record<Locale, LocaleStrings> = {
  en: {
    today: 'Today',
    tomorrow: 'Tomorrow',
    yesterday: 'Yesterday',
    weekdays: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    am: 'AM',
    pm: 'PM',
  },
  sv: {
    today: 'Idag',
    tomorrow: 'Imorgon',
    yesterday: 'Igår',
    weekdays: ['sön', 'mån', 'tis', 'ons', 'tor', 'fre', 'lör'],
    months: ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'],
    am: 'fm',
    pm: 'em',
  },
};

function monthName(s: LocaleStrings, month: number): string {
  return s.months[month - 1] ?? '';
}

/** Day-first unless the locale is English with `MMM d`. */
function isMonthFirst(ctx: FormatContext): boolean {
  return ctx.locale === 'en' && ctx.dateFormat === 'MMM d';
}

function withYear(label: string, year: number, ctx: FormatContext): string {
  return isMonthFirst(ctx) ? `${label}, ${year}` : `${label} ${year}`;
}

function dayMonth(p: DateParts, ctx: FormatContext): string {
  const mon = monthName(STRINGS[ctx.locale], p.month);
  return isMonthFirst(ctx) ? `${mon} ${p.day}` : `${p.day} ${mon}`;
}

function absoluteDate(p: DateParts, showYear: boolean, ctx: FormatContext): string {
  const label = dayMonth(p, ctx);
  return showYear ? withYear(label, p.year, ctx) : label;
}

function dayLabel(date: IsoDate, ctx: FormatContext): string {
  const s = STRINGS[ctx.locale];
  const days = diffDays(date, ctx.today);
  if (days === 0) return s.today;
  if (days === 1) return s.tomorrow;
  if (days === -1) return s.yesterday;
  if (days >= 2 && days <= 6) return s.weekdays[weekdayOf(date)];
  const p = parseIsoDate(date);
  return absoluteDate(p, p.year !== parseIsoDate(ctx.today).year, ctx);
}

function rangeLabel(start: DateParts, due: DateParts, ctx: FormatContext): string {
  if (start.year !== due.year) {
    return `${absoluteDate(start, true, ctx)} – ${absoluteDate(due, true, ctx)}`;
  }
  const s = STRINGS[ctx.locale];
  let label: string;
  if (start.month !== due.month) {
    label = `${dayMonth(start, ctx)} – ${dayMonth(due, ctx)}`;
  } else if (isMonthFirst(ctx)) {
    label = `${monthName(s, due.month)} ${start.day} – ${due.day}`;
  } else if (ctx.locale === 'sv') {
    label = `${start.day}–${due.day} ${monthName(s, due.month)}`;
  } else {
    label = `${start.day} – ${due.day} ${monthName(s, due.month)}`;
  }
  return due.year === parseIsoDate(ctx.today).year ? label : withYear(label, due.year, ctx);
}

/** `14:00` in 24 h; `2 PM` / `2:30 PM` (sv: `2 em`) in 12 h. */
export function formatTime(time: string, locale: Locale, timeFormat: TimeFormat): string {
  const { hour, minute } = parseTime(time);
  if (timeFormat === '24h') return time;
  const s = STRINGS[locale];
  const h = hour % 12 === 0 ? 12 : hour % 12;
  const mm = minute === 0 ? '' : `:${String(minute).padStart(2, '0')}`;
  return `${h}${mm} ${hour < 12 ? s.am : s.pm}`;
}

/** The relative date label shown in the due-date cell (02 §8.3). */
export function formatRelative(input: RelativeInput, ctx: FormatContext): string {
  const { dueDate, startDate, dueTime } = input;
  const label =
    startDate && diffDays(startDate, dueDate) < 0
      ? rangeLabel(parseIsoDate(startDate), parseIsoDate(dueDate), ctx)
      : dayLabel(dueDate, ctx);
  return dueTime ? `${label} ${formatTime(dueTime, ctx.locale, ctx.timeFormat)}` : label;
}
