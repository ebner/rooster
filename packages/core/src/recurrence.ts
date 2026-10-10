import {
  addDays,
  daysInMonth,
  diffDays,
  formatIsoDate,
  isValidIsoDate,
  parseIsoDate,
  weekdayOf,
} from './dates/iso.ts';

/**
 * Recurring tasks (FR-REC, 05 §6, ADR 0049). Rules are an RFC 5545 RRULE subset stored without
 * the `RRULE:` prefix; every date is a floating `YYYY-MM-DD` string, so nothing here depends on
 * a timezone or on DST.
 *
 * Pure: no IO and no clock. Callers pass "today" / the completion date as ISO dates.
 */

export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const RECURRENCE_FREQS = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const;
export type RecurrenceFreq = (typeof RECURRENCE_FREQS)[number];
export type RecurrenceBasis = 'due' | 'completion';

export interface RecurrenceDay {
  weekday: Weekday;
  /** MONTHLY only: 1–4 (the nth weekday) or -1 (the last). Absent = every such weekday. */
  nth?: number;
}

export interface RecurrenceRule {
  freq: RecurrenceFreq;
  /** ≥ 1. */
  interval: number;
  /** WEEKLY: the weekdays (no `nth`). MONTHLY: exactly one day with `nth`. */
  byDay?: RecurrenceDay[];
  /** MONTHLY or YEARLY: 1–31, clamped to the month's last day. */
  byMonthDay?: number;
  /** YEARLY: 1–12. */
  byMonth?: number;
  /** End condition: the number of instances left including the current one (ADR 0049). */
  count?: number;
  /** End condition: the last date an instance may fall on, as `YYYY-MM-DD`. */
  until?: string;
}

const PART = /^([A-Z]+)=([A-Z0-9,+-]+)$/;
const DAY = /^(-1|[1-4])?(MO|TU|WE|TH|FR|SA|SU)$/;
const UNTIL = /^(\d{4})(\d{2})(\d{2})$/;
const MAX_INTERVAL = 999;
const MAX_COUNT = 9999;

function intIn(raw: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

/**
 * Parses a stored rule. Returns null for anything outside the subset: unknown or repeated
 * parts, `COUNT` together with `UNTIL`, `BYDAY` with `nth` outside MONTHLY, more than one
 * monthly day, `BYMONTH` outside YEARLY, and out-of-range numbers.
 */
export function parseRule(raw: string): RecurrenceRule | null {
  if (raw.length === 0 || raw.length > 200) return null;
  const seen = new Set<string>();
  let freq: RecurrenceFreq | undefined;
  const out: Partial<RecurrenceRule> = {};
  for (const part of raw.split(';')) {
    const m = PART.exec(part);
    if (m === null) return null;
    const [, key, value] = m as unknown as [string, string, string];
    if (seen.has(key)) return null;
    seen.add(key);
    switch (key) {
      case 'FREQ':
        if (!(RECURRENCE_FREQS as readonly string[]).includes(value)) return null;
        freq = value as RecurrenceFreq;
        break;
      case 'INTERVAL': {
        const n = intIn(value, 1, MAX_INTERVAL);
        if (n === null) return null;
        out.interval = n;
        break;
      }
      case 'BYDAY': {
        const days: RecurrenceDay[] = [];
        for (const d of value.split(',')) {
          const dm = DAY.exec(d);
          if (dm === null) return null;
          const weekday = dm[2] as Weekday;
          if (days.some((x) => x.weekday === weekday && x.nth === undefined)) return null;
          days.push(dm[1] === undefined ? { weekday } : { weekday, nth: Number(dm[1]) });
        }
        out.byDay = days;
        break;
      }
      case 'BYMONTHDAY': {
        const n = intIn(value, 1, 31);
        if (n === null) return null;
        out.byMonthDay = n;
        break;
      }
      case 'BYMONTH': {
        const n = intIn(value, 1, 12);
        if (n === null) return null;
        out.byMonth = n;
        break;
      }
      case 'COUNT': {
        const n = intIn(value, 1, MAX_COUNT);
        if (n === null) return null;
        out.count = n;
        break;
      }
      case 'UNTIL': {
        const um = UNTIL.exec(value);
        if (um === null) return null;
        const iso = `${um[1]}-${um[2]}-${um[3]}`;
        const d = new Date(`${iso}T00:00:00Z`);
        if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return null;
        out.until = iso;
        break;
      }
      default:
        return null;
    }
  }
  if (freq === undefined) return null;
  if (out.count !== undefined && out.until !== undefined) return null;
  const rule: RecurrenceRule = { ...out, freq, interval: out.interval ?? 1 };
  if (rule.byDay !== undefined) {
    const nths = rule.byDay.filter((d) => d.nth !== undefined).length;
    if (freq === 'WEEKLY' && nths > 0) return null;
    if (freq === 'MONTHLY' && (rule.byDay.length !== 1 || nths !== 1)) return null;
    if (freq !== 'WEEKLY' && freq !== 'MONTHLY') return null;
    if (rule.byMonthDay !== undefined) return null;
  }
  if (rule.byMonthDay !== undefined && freq !== 'MONTHLY' && freq !== 'YEARLY') return null;
  if (rule.byMonth !== undefined && freq !== 'YEARLY') return null;
  return rule;
}

/** The canonical string: FREQ, INTERVAL (when > 1), BYDAY in MO…SU order, BYMONTH, BYMONTHDAY, COUNT/UNTIL. */
export function formatRule(rule: RecurrenceRule): string {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byDay !== undefined && rule.byDay.length > 0) {
    const days = [...rule.byDay].sort(
      (a, b) => WEEKDAYS.indexOf(a.weekday) - WEEKDAYS.indexOf(b.weekday),
    );
    parts.push(`BYDAY=${days.map((d) => `${d.nth ?? ''}${d.weekday}`).join(',')}`);
  }
  if (rule.byMonth !== undefined) parts.push(`BYMONTH=${rule.byMonth}`);
  if (rule.byMonthDay !== undefined) parts.push(`BYMONTHDAY=${rule.byMonthDay}`);
  if (rule.count !== undefined) parts.push(`COUNT=${rule.count}`);
  if (rule.until !== undefined) parts.push(`UNTIL=${rule.until.replaceAll('-', '')}`);
  return parts.join(';');
}

export function isValidRule(raw: string): boolean {
  return parseRule(raw) !== null;
}

/** The rule's weekday for a date (`weekdayOf` counts from Sunday, RFC 5545 from Monday). */
export function weekdayCode(date: string): Weekday {
  return WEEKDAYS[(weekdayOf(date) + 6) % 7] as Weekday;
}

/** Monday-based index 0–6. */
const dayIndex = (weekday: Weekday) => WEEKDAYS.indexOf(weekday);

function anchored(rule: RecurrenceRule, dueDate: string, basis: RecurrenceBasis): RecurrenceRule {
  const end = {
    ...(rule.count === undefined ? {} : { count: rule.count }),
    ...(rule.until === undefined ? {} : { until: rule.until }),
  };
  if (basis === 'completion') return { freq: rule.freq, interval: rule.interval, ...end };
  const { month, day } = parseIsoDate(dueDate);
  switch (rule.freq) {
    case 'DAILY':
      return { freq: 'DAILY', interval: rule.interval, ...end };
    case 'WEEKLY':
      return {
        freq: 'WEEKLY',
        interval: rule.interval,
        byDay: rule.byDay?.length ? rule.byDay : [{ weekday: weekdayCode(dueDate) }],
        ...end,
      };
    case 'MONTHLY':
      return rule.byDay?.length
        ? { freq: 'MONTHLY', interval: rule.interval, byDay: rule.byDay, ...end }
        : { freq: 'MONTHLY', interval: rule.interval, byMonthDay: rule.byMonthDay ?? day, ...end };
    case 'YEARLY':
      return {
        freq: 'YEARLY',
        interval: rule.interval,
        byMonth: rule.byMonth ?? month,
        byMonthDay: rule.byMonthDay ?? day,
        ...end,
      };
  }
}

/**
 * The rule as the server stores it (ADR 0049): canonical, with the anchor made explicit from
 * the due date so that month-end clamping never drifts (WEEKLY without BYDAY gets the due
 * date's weekday; MONTHLY without BYDAY/BYMONTHDAY gets its day; YEARLY gets BYMONTH and
 * BYMONTHDAY). With basis `completion` only FREQ, INTERVAL and the end condition are kept.
 * Idempotent. Null when the rule or the due date is invalid.
 */
export function normalizeRule(raw: string, dueDate: string, basis: RecurrenceBasis): string | null {
  const rule = parseRule(raw);
  if (rule === null || !isValidIsoDate(dueDate)) return null;
  return formatRule(anchored(rule, dueDate, basis));
}

/** A month counted from year 0 (`year * 12 + month - 1`), for month arithmetic. */
const monthIndex = (date: string) => {
  const { year, month } = parseIsoDate(date);
  return year * 12 + month - 1;
};

/** Day `day` of the month `index` (see `monthIndex`), clamped to its last day. */
function clampedDay(index: number, day: number): string {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return formatIsoDate({ year, month, day: Math.min(day, daysInMonth(year, month)) });
}

/** The nth (1–4) or last (-1) `weekday` of the month `index`. */
function nthWeekday(index: number, weekday: Weekday, nth: number): string {
  const first = clampedDay(index, 1);
  if (nth > 0) {
    const offset = (dayIndex(weekday) - dayIndex(weekdayCode(first)) + 7) % 7;
    return addDays(first, offset + (nth - 1) * 7);
  }
  const last = clampedDay(index, 31);
  return addDays(last, -((dayIndex(weekdayCode(last)) - dayIndex(weekday) + 7) % 7));
}

/** `date` plus `n` periods of `freq`; months and years clamp to the month's last day. */
function addPeriods(date: string, freq: RecurrenceFreq, n: number): string {
  const { day } = parseIsoDate(date);
  switch (freq) {
    case 'DAILY':
      return addDays(date, n);
    case 'WEEKLY':
      return addDays(date, 7 * n);
    case 'MONTHLY':
      return clampedDay(monthIndex(date) + n, day);
    case 'YEARLY':
      return clampedDay(monthIndex(date) + 12 * n, day);
  }
}

/**
 * The first occurrence of an anchored rule on or after `target`, counting the INTERVAL cadence
 * from the period (day, Monday-based week, month or year) that contains `anchor` (RFC 5545:
 * the period of DTSTART). `target` must not be before `anchor`.
 */
function occurrenceOnOrAfter(rule: RecurrenceRule, anchor: string, target: string): string {
  const step = rule.interval;
  /** The first whole cadence step at or before `periods` periods after the anchor's period. */
  const from = (periods: number) => Math.floor(periods / step) * step;
  switch (rule.freq) {
    case 'DAILY':
      return addDays(anchor, Math.ceil(diffDays(target, anchor) / step) * step);
    case 'WEEKLY': {
      const week = addDays(anchor, -dayIndex(weekdayCode(anchor)));
      const days = (rule.byDay ?? []).map((d) => dayIndex(d.weekday)).sort((a, b) => a - b);
      let k = from(Math.floor(diffDays(target, week) / 7));
      for (;;) {
        for (const d of days) {
          const date = addDays(week, 7 * k + d);
          if (date >= target) return date;
        }
        k += step;
      }
    }
    case 'MONTHLY':
    case 'YEARLY': {
      const yearly = rule.freq === 'YEARLY';
      const period = (date: string) => (yearly ? parseIsoDate(date).year : monthIndex(date));
      const nth = rule.byDay?.[0];
      const at = (p: number) => {
        const index = yearly ? p * 12 + (rule.byMonth ?? 1) - 1 : p;
        return nth === undefined
          ? clampedDay(index, rule.byMonthDay ?? 1)
          : nthWeekday(index, nth.weekday, nth.nth ?? 1);
      };
      const start = period(anchor);
      let k = from(period(target) - start);
      for (;;) {
        const date = at(start + k);
        if (date >= target) return date;
        k += step;
      }
    }
  }
}

/** Applies the end condition to a candidate next date of a series whose rule is `rule`. */
function withinEnd(rule: RecurrenceRule, date: string): string | null {
  if (rule.count !== undefined && rule.count <= 1) return null;
  if (rule.until !== undefined && date > rule.until) return null;
  return date;
}

/**
 * The next due date of a series, or null when the series has ended (UNTIL passed, COUNT used
 * up) or an argument is invalid. Basis `due`: the first occurrence of the rule strictly after
 * `fromDate` (the completed instance's due date) that is not before `completedOn` (ADR 0049:
 * a late completion does not leave a trail of overdue instances). Basis `completion`:
 * `completedOn` + INTERVAL × FREQ.
 */
export function nextOccurrence(
  rule: string,
  basis: RecurrenceBasis,
  fromDate: string,
  completedOn: string,
): string | null {
  const parsed = parseRule(rule);
  if (parsed === null || !isValidIsoDate(fromDate) || !isValidIsoDate(completedOn)) return null;
  if (basis === 'completion') {
    return withinEnd(parsed, addPeriods(completedOn, parsed.freq, parsed.interval));
  }
  const after = addDays(fromDate, 1);
  const target = completedOn > after ? completedOn : after;
  return withinEnd(
    parsed,
    occurrenceOnOrAfter(anchored(parsed, fromDate, 'due'), fromDate, target),
  );
}

/**
 * The first due date of a new series: the first occurrence of the rule on or after `today`,
 * anchored on `today` (so "every month" starts today and "every 2 weeks" in this week). Basis
 * `completion` starts today. Null when the rule is invalid or ends before it starts.
 */
export function firstOccurrence(
  rule: string,
  basis: RecurrenceBasis,
  today: string,
): string | null {
  const parsed = parseRule(rule);
  if (parsed === null || !isValidIsoDate(today)) return null;
  const date =
    basis === 'completion'
      ? today
      : occurrenceOnOrAfter(anchored(parsed, today, 'due'), today, today);
  return parsed.until !== undefined && date > parsed.until ? null : date;
}

/**
 * The next instance's dates and rule (FR-REC-3): the due date from `nextOccurrence`, the start
 * date shifted by the same number of days, and the rule (normalised against the current due
 * date) with COUNT decremented. Null when the series ends with this completion.
 */
export function nextInstance(
  rule: string,
  basis: RecurrenceBasis,
  current: { dueDate: string; startDate: string | null },
  completedOn: string,
): { dueDate: string; startDate: string | null; recurrence: string } | null {
  const dueDate = nextOccurrence(rule, basis, current.dueDate, completedOn);
  if (dueDate === null) return null;
  const parsed = anchored(parseRule(rule) as RecurrenceRule, current.dueDate, basis);
  const recurrence = formatRule(
    parsed.count === undefined ? parsed : { ...parsed, count: parsed.count - 1 },
  );
  const startDate =
    current.startDate === null
      ? null
      : addDays(current.startDate, diffDays(dueDate, current.dueDate));
  return { dueDate, startDate, recurrence };
}

// ---------------------------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------------------------

export type RecurrencePresetId = 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly';

/**
 * The repeat menu's presets for a task due on `dueDate`, as normalised rules (basis `due`):
 * every day, every weekday (MO–FR), weekly on the due weekday, monthly on the due day and
 * yearly on the due date. A stored rule equals a preset's string exactly when it is that
 * preset (both are normalised against the same due date and carry no end condition).
 */
export function recurrencePresets(dueDate: string): { id: RecurrencePresetId; rule: string }[] {
  const { month, day } = parseIsoDate(dueDate);
  return [
    { id: 'daily', rule: 'FREQ=DAILY' },
    { id: 'weekdays', rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' },
    { id: 'weekly', rule: `FREQ=WEEKLY;BYDAY=${weekdayCode(dueDate)}` },
    { id: 'monthly', rule: `FREQ=MONTHLY;BYMONTHDAY=${day}` },
    { id: 'yearly', rule: `FREQ=YEARLY;BYMONTH=${month};BYMONTHDAY=${day}` },
  ];
}

/** The id of the preset `rule` is (ignoring an end condition), or null for a custom rule. */
export function presetOf(rule: string, dueDate: string): RecurrencePresetId | null {
  const parsed = parseRule(rule);
  if (parsed === null || !isValidIsoDate(dueDate)) return null;
  const { count: _count, until: _until, ...bare } = anchored(parsed, dueDate, 'due');
  const formatted = formatRule(bare);
  return recurrencePresets(dueDate).find((p) => p.rule === formatted)?.id ?? null;
}

/**
 * A rule taken apart for display, so the web and the CLI can localise it ("Every 2 weeks on
 * Mon and Thu", "Monthly on the last Fri", "3 days after completion", "… 4 times", "… until
 * Dec 31"). Missing anchors are not filled in: callers that know the due date pass a
 * normalised rule.
 */
export interface RecurrenceDescription {
  basis: RecurrenceBasis;
  freq: RecurrenceFreq;
  interval: number;
  /** WEEKLY: the weekdays, Monday first. */
  weekdays?: Weekday[];
  /** WEEKLY with interval 1 on exactly Monday–Friday ("every weekday"). */
  everyWeekday: boolean;
  /** MONTHLY/YEARLY: the day of the month (clamped to short months). */
  monthDay?: number;
  /** YEARLY: 1–12. */
  month?: number;
  /** MONTHLY: the nth (1–4) or last (-1) weekday. */
  nthWeekday?: { nth: number; weekday: Weekday };
  end: { kind: 'never' } | { kind: 'count'; count: number } | { kind: 'until'; until: string };
}

export function describeRule(
  rule: string,
  basis: RecurrenceBasis = 'due',
): RecurrenceDescription | null {
  const parsed = parseRule(rule);
  if (parsed === null) return null;
  const end: RecurrenceDescription['end'] =
    parsed.count !== undefined
      ? { kind: 'count', count: parsed.count }
      : parsed.until !== undefined
        ? { kind: 'until', until: parsed.until }
        : { kind: 'never' };
  const base = { basis, freq: parsed.freq, interval: parsed.interval, end };
  if (basis === 'completion') return { ...base, everyWeekday: false };
  const weekdays =
    parsed.freq === 'WEEKLY' && parsed.byDay?.length
      ? parsed.byDay.map((d) => d.weekday).sort((a, b) => dayIndex(a) - dayIndex(b))
      : undefined;
  const nth = parsed.freq === 'MONTHLY' ? parsed.byDay?.[0] : undefined;
  return {
    ...base,
    ...(weekdays === undefined ? {} : { weekdays }),
    everyWeekday: parsed.interval === 1 && weekdays?.join(',') === 'MO,TU,WE,TH,FR',
    ...(parsed.byMonthDay === undefined ? {} : { monthDay: parsed.byMonthDay }),
    ...(parsed.byMonth === undefined ? {} : { month: parsed.byMonth }),
    ...(nth === undefined ? {} : { nthWeekday: { nth: nth.nth ?? 1, weekday: nth.weekday } }),
  };
}
