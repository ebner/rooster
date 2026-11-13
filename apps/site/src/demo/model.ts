import {
  type DateParseContext,
  type DueState,
  dueState,
  findDateInTitle,
  findReminderTokens,
  findTagTokens,
  formatRelative,
  type ParseLocale,
  type ReminderTokenMatch,
  removeSpans,
  stripBackticks,
  type TagTokenMatch,
  type TitleDateMatch,
} from '@rooster/core/dates';
import { describeRule, WEEKDAYS, type Weekday } from '@rooster/core/recurrence';
import type { Copy } from '../copy/en.ts';

/**
 * The parser demo (ADR 0070): what the app does with a typed title (02 §8.1), as a pure
 * function over core, so the page shows exactly what rooster would save.
 */

export type SegmentKind = 'text' | 'date' | 'tag' | 'reminder';

export interface Segment {
  kind: SegmentKind;
  text: string;
}

export interface DemoContext {
  today: string;
  nowMs: number;
  timeZone: string;
  locale: ParseLocale;
}

export interface DemoResult {
  /** The title split into highlighted tokens and plain text, covering every character. */
  segments: Segment[];
  /** The title as saved, without the tokens. */
  title: string;
  due: { label: string; state: DueState; repeats: string | null } | null;
  tags: string[];
  reminders: string[];
}

interface Span {
  start: number;
  end: number;
}

interface Parsed {
  title: string;
  date: TitleDateMatch | null;
  tags: TagTokenMatch[];
  reminders: ReminderTokenMatch[];
}

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();
const blank = (text: string, span: Span) =>
  `${text.slice(0, span.start)}${' '.repeat(span.end - span.start)}${text.slice(span.end)}`;

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''));

/**
 * The app's `parseTitle` (apps/web/src/features/list/title-tokens.ts), step for step, keeping
 * the tokens' spans for the highlight: reminder tokens count only with a date and are parsed
 * out first; a title that would be empty without its date phrase keeps the phrase as text (and
 * its tags); one made only of tokens keeps all of its text; escape backticks are stripped.
 */
function parseLikeApp(raw: string, ctx: DateParseContext): Parsed {
  const plain = (title: string): Parsed => ({ title, date: null, tags: [], reminders: [] });
  const match = findDateInTitle(raw, ctx);
  const reminders = match ? findReminderTokens(raw) : [];
  if (reminders.length > 0) {
    const parsed = parseLikeApp(reminders.reduce(blank, raw), ctx);
    if (parsed.title === '') return plain(collapse(stripBackticks(raw)));
    // Without a date the app has nothing to remind of, so they show as text.
    return parsed.date ? { ...parsed, reminders } : parsed;
  }
  const tags = findTagTokens(raw);
  if (match) {
    const title = collapse(stripBackticks(removeSpans(raw, [match, ...tags])));
    if (title !== '') return { title, date: match, tags, reminders: [] };
  }
  const title = collapse(stripBackticks(tags.length > 0 ? removeSpans(raw, tags) : raw));
  if (title === '') return plain(collapse(stripBackticks(raw)));
  return { title, date: null, tags, reminders: [] };
}

export function analyse(raw: string, ctx: DemoContext, copy: Copy['dates']): DemoResult {
  const parseCtx: DateParseContext = {
    today: ctx.today,
    locale: ctx.locale,
    weekStart: 1,
    dateFormat: ctx.locale === 'sv' ? 'd MMM' : 'MMM d',
  };
  const parsed = parseLikeApp(raw, parseCtx);
  const { date } = parsed;

  const spans: (Span & { kind: SegmentKind })[] = [
    ...(date ? [{ start: date.start, end: date.end, kind: 'date' as const }] : []),
    ...parsed.tags.map((t) => ({ start: t.start, end: t.end, kind: 'tag' as const })),
    ...parsed.reminders.map((r) => ({ start: r.start, end: r.end, kind: 'reminder' as const })),
  ].sort((a, b) => a.start - b.start);
  const segments: Segment[] = [];
  let at = 0;
  for (const span of spans) {
    if (span.start < at) continue;
    if (span.start > at) segments.push({ kind: 'text', text: raw.slice(at, span.start) });
    segments.push({ kind: span.kind, text: raw.slice(span.start, span.end) });
    at = span.end;
  }
  if (at < raw.length) segments.push({ kind: 'text', text: raw.slice(at) });

  const seen = new Set<string>();
  const tagNames = parsed.title
    ? parsed.tags
        .map((t) => t.name)
        .filter((name) => {
          const key = name.toLocaleLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
    : [];

  return {
    segments,
    title: parsed.title,
    due: date
      ? {
          label: formatRelative(
            { dueDate: date.date, dueTime: date.time },
            {
              today: ctx.today,
              locale: ctx.locale,
              dateFormat: parseCtx.dateFormat,
              timeFormat: '24h',
            },
          ),
          state: dueState(
            { dueDate: date.date, dueTime: date.time, dueTz: ctx.timeZone, completed: false },
            { today: ctx.today, nowMs: ctx.nowMs, viewerTz: ctx.timeZone },
          ),
          repeats: date.recurrence
            ? repeatText(date.recurrence.rule, date.recurrence.basis, ctx.locale, copy)
            : null,
        }
      : null,
    tags: tagNames,
    reminders: [...new Set(parsed.reminders.map((r) => r.offsetMinutes))].map((m) =>
      reminderText(m, copy),
    ),
  };
}

export function reminderText(minutes: number, copy: Copy['dates']): string {
  const r = copy.reminder;
  if (minutes === 0) return r.atDue;
  if (minutes % 1440 === 0) return minutes === 1440 ? r.day : fill(r.days, { n: minutes / 1440 });
  if (minutes % 60 === 0) return fill(r.hours, { n: minutes / 60 });
  return fill(r.minutes, { n: minutes });
}

/** RFC 5545 weekdays count from Monday; this is a Monday in January 2024. */
function weekdayName(day: Weekday, locale: ParseLocale): string {
  const date = new Date(Date.UTC(2024, 0, 1 + WEEKDAYS.indexOf(day)));
  return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(date);
}

export function repeatText(
  rule: string,
  basis: 'due' | 'completion',
  locale: ParseLocale,
  copy: Copy['dates'],
): string {
  const d = describeRule(rule, basis);
  const r = copy.repeat;
  if (!d) return '';
  const n = d.interval;
  if (d.basis === 'completion') {
    const unit: Record<typeof d.freq, readonly [string, string]> = {
      DAILY: [r.afterDay, r.afterDays],
      WEEKLY: [r.afterWeek, r.afterWeeks],
      MONTHLY: [r.afterMonth, r.afterMonths],
      YEARLY: [r.afterYear, r.afterYears],
    };
    const [one, many] = unit[d.freq];
    return n === 1 ? one : fill(many, { n });
  }
  switch (d.freq) {
    case 'DAILY':
      return n === 1 ? r.daily : fill(r.dailyN, { n });
    case 'WEEKLY': {
      if (d.everyWeekday) return r.weekdays;
      const list = new Intl.ListFormat(locale, { type: 'conjunction' });
      const days = list.format((d.weekdays ?? []).map((w) => weekdayName(w, locale)));
      return n === 1 ? fill(r.weekly, { days }) : fill(r.weeklyN, { n, days });
    }
    case 'MONTHLY':
      return n === 1 ? r.monthly : fill(r.monthlyN, { n });
    case 'YEARLY':
      return n === 1 ? r.yearly : fill(r.yearlyN, { n });
  }
}
