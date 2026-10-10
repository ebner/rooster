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

/**
 * The rule as the server stores it (ADR 0049): canonical, with the anchor made explicit from
 * the due date so that month-end clamping never drifts (WEEKLY without BYDAY gets the due
 * date's weekday; MONTHLY without BYDAY/BYMONTHDAY gets its day; YEARLY gets BYMONTH and
 * BYMONTHDAY). With basis `completion` only FREQ, INTERVAL and the end condition are kept.
 * Null when the rule is invalid.
 */
export function normalizeRule(
  _raw: string,
  _dueDate: string,
  _basis: RecurrenceBasis,
): string | null {
  throw new Error('normalizeRule: not implemented yet (P10 core WP 10.1)');
}

/**
 * The next due date of a series, or null when the series has ended (UNTIL passed, COUNT used
 * up). Basis `due`: the first occurrence of the rule strictly after `fromDate` (the completed
 * instance's due date) that is not before `completedOn` (ADR 0049: a late completion does not
 * leave a trail of overdue instances). Basis `completion`: `completedOn` + INTERVAL × FREQ.
 */
export function nextOccurrence(
  _rule: string,
  _basis: RecurrenceBasis,
  _fromDate: string,
  _completedOn: string,
): string | null {
  throw new Error('nextOccurrence: not implemented yet (P10 core WP 10.1)');
}

/**
 * The next instance's dates and rule (FR-REC-3): the due date from `nextOccurrence`, the start
 * date shifted by the same number of days, and the rule with COUNT decremented. Null when the
 * series ends with this completion.
 */
export function nextInstance(
  _rule: string,
  _basis: RecurrenceBasis,
  _current: { dueDate: string; startDate: string | null },
  _completedOn: string,
): { dueDate: string; startDate: string | null; recurrence: string } | null {
  throw new Error('nextInstance: not implemented yet (P10 core WP 10.1)');
}
