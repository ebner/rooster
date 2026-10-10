/**
 * Recurrence phrases (02 §8.2, FR-REC-2), read by a small recursive scanner over the vocabulary
 * tables. `RecurrenceScanner.at` returns the longest recurrence starting at a position; the
 * date parser treats it as one more end-only phrase (a time suffix may follow).
 *
 * Decisions where 02 §8.2 is silent (ADR 0049 amendment):
 * - The first due date is the first occurrence on or after today; "after done" starts today.
 * - English "every <ordinal> <weekday>" ("every 2nd fri", "every last fri") is the nth weekday
 *   of the month; "every other fri" and Swedish "varannan fredag" / "var andra fredag" are
 *   every second week.
 * - "after done" only follows an interval phrase ("every 3 days", "weekly"), never weekdays.
 */
import {
  firstOccurrence,
  formatRule,
  normalizeRule,
  type RecurrenceBasis,
  type RecurrenceFreq,
  type RecurrenceRule,
  WEEKDAYS as RULE_WEEKDAYS,
  type Weekday as RuleWeekday,
} from '../recurrence.ts';
import { daysInMonth } from './iso.ts';
import { execAt, type Mode, type ParseLocale, sticky, Vocab } from './parse-lexer.ts';
import {
  AFTER_DONE,
  COUNTS,
  EVERY,
  EVERY_OTHER,
  FREQ_ADVERBS,
  FREQ_UNITS,
  MONTHS,
  NTHS,
  OF_MONTH,
  OF_YEAR,
  ON,
  ON_ALL,
  type VocabEntry,
  WEEKDAY_FORMS,
  WEEKDAYS,
  WORKDAYS,
} from './parse-vocab.ts';

export interface RecurrenceMatch {
  end: number;
  /** The series' first due date: the first occurrence on or after today. */
  date: string;
  recurrence: { rule: string; basis: RecurrenceBasis };
}

interface Hit<T> {
  end: number;
  value: T;
}

interface Draft {
  end: number;
  rule: RecurrenceRule;
  basis: RecurrenceBasis;
}

class Word<T> {
  private readonly vocab: Vocab<T>;
  private readonly re: RegExp;

  constructor(all: readonly VocabEntry<T>[], mode: Mode, locale: ParseLocale) {
    this.vocab = new Vocab(all, mode, locale);
    // A table with nothing active in this mode (Swedish-only words in English titles) never matches.
    this.re = this.vocab.pattern === '' ? /(?!)/y : sticky(`(${this.vocab.pattern})`);
  }

  read(text: string, pos: number | null): Hit<T> | null {
    if (pos === null) return null;
    const m = execAt(this.re, text, pos);
    return m ? { end: this.re.lastIndex, value: this.vocab.get(m[1] as string).value } : null;
  }
}

const SPACE = /\s+/y;
const JOINER = /\s*,\s*(?:(?:and|och)\s+)?|\s+(?:and|och|&|\+)\s+/iuy;
const DIGIT_COUNT = sticky(String.raw`(\d{1,3})(?::e|:a|e|st|nd|rd|th)?`);
const DAY_NUMBER = sticky(String.raw`(?:(the|den)\s+)?(\d{1,2})(st|nd|rd|th|:e|e)?`);
const THE = /the\s+/iuy;
const WORKWEEK: RuleWeekday[] = ['MO', 'TU', 'WE', 'TH', 'FR'];

/** Past at least one whitespace character at `pos`, or null. */
function space(text: string, pos: number | null): number | null {
  if (pos === null) return null;
  return execAt(SPACE, text, pos) ? SPACE.lastIndex : null;
}

const ruleWeekday = (weekday: number) => RULE_WEEKDAYS[(weekday + 6) % 7] as RuleWeekday;

export class RecurrenceScanner {
  private readonly every: Word<'every' | 'var'>;
  private readonly other: Word<2>;
  private readonly counts: Word<number>;
  private readonly nths: Word<number>;
  private readonly units: Word<RecurrenceFreq>;
  private readonly adverbs: Word<{ freq: RecurrenceFreq; interval: number }>;
  private readonly workdays: Word<null>;
  private readonly weekdays: Word<number>;
  private readonly plurals: Word<number>;
  private readonly onAll: Word<null>;
  private readonly on: Word<null>;
  private readonly ofMonth: Word<null>;
  private readonly ofYear: Word<null>;
  private readonly afterDone: Word<null>;
  private readonly monthDay: RegExp;
  private readonly monthNames: Vocab<number>;

  constructor(mode: Mode, locale: ParseLocale) {
    const w = <T>(all: readonly VocabEntry<T>[]) => new Word(all, mode, locale);
    this.every = w(EVERY);
    this.other = w(EVERY_OTHER);
    this.counts = w(COUNTS);
    this.nths = w(NTHS);
    this.units = w(FREQ_UNITS);
    this.adverbs = w(FREQ_ADVERBS);
    this.workdays = w(WORKDAYS);
    this.weekdays = w([...WEEKDAYS, ...WEEKDAY_FORMS]);
    this.plurals = w(WEEKDAY_FORMS);
    this.onAll = w(ON_ALL);
    this.on = w(ON);
    this.ofMonth = w(OF_MONTH);
    this.ofYear = w(OF_YEAR);
    this.afterDone = w(AFTER_DONE);
    this.monthNames = new Vocab(MONTHS, mode, locale);
    const month = `(${this.monthNames.pattern})`;
    this.monthDay = sticky(
      String.raw`(?:(?:on|den)\s+)?(?:${month}\s+(\d{1,2})(?:st|nd|rd|th)?|(\d{1,2})(?:st|nd|rd|th|:e)?(?:\s+of)?\s+${month})`,
    );
  }

  /** The longest recurrence phrase starting at `pos`, resolved against `today`. */
  at(text: string, pos: number, today: string): RecurrenceMatch | null {
    const drafts: Draft[] = [];
    this.scan(text, pos, drafts);
    let best: Draft | null = null;
    for (const d of drafts) if (!best || d.end > best.end) best = d;
    if (!best) return null;
    const raw = formatRule(best.rule);
    const date = firstOccurrence(raw, best.basis, today);
    const rule = date === null ? null : normalizeRule(raw, date, best.basis);
    if (date === null || rule === null) return null;
    return { end: best.end, date, recurrence: { rule, basis: best.basis } };
  }

  private scan(text: string, pos: number, out: Draft[]): void {
    const push = (end: number, rule: Omit<RecurrenceRule, 'interval'> & { interval?: number }) =>
      out.push({ end, rule: { interval: 1, ...rule }, basis: 'due' });

    // every …, each …, varje …, var …
    const lead = this.every.read(text, pos);
    if (lead) this.afterEvery(text, space(text, lead.end), lead.value, out);

    // varannan vecka, varannan fredag
    const other = this.other.read(text, pos);
    if (other) {
      const p = space(text, other.end);
      const unit = this.units.read(text, p);
      if (unit) this.unitTail(text, unit.end, unit.value, other.value, out);
      const days = this.days(text, p, this.weekdays);
      if (days) push(days.end, { freq: 'WEEKLY', interval: 2, byDay: days.value });
    }

    // daily, weekly on mon, monthly on the 15th
    const adverb = this.adverbs.read(text, pos);
    if (adverb) this.unitTail(text, adverb.end, adverb.value.freq, adverb.value.interval, out);

    // on weekdays, på vardagar, alla vardagar, on mondays and thursdays
    const onAll = this.onAll.read(text, pos);
    if (onAll) {
      const p = space(text, onAll.end);
      const workdays = this.workdays.read(text, p);
      if (workdays)
        push(workdays.end, { freq: 'WEEKLY', byDay: WORKWEEK.map((weekday) => ({ weekday })) });
      const days = this.days(text, p, this.plurals);
      if (days) push(days.end, { freq: 'WEEKLY', byDay: days.value });
    }

    // [on] the 15th of every month, den 15:e varje månad
    const lead2 = this.on.read(text, pos);
    for (const start of [pos, space(text, lead2?.end ?? null)]) {
      if (start === null) continue;
      const day = this.dayNumber(text, start, true);
      const of = day && this.ofMonth.read(text, space(text, day.end));
      if (day && of) push(of.end, { freq: 'MONTHLY', byMonthDay: day.value });
      // [on] [the] last friday of the month, sista fredagen i månaden
      const nth = this.nthWeekday(text, start);
      const ofNth = nth && this.ofMonth.read(text, space(text, nth.end));
      if (nth && ofNth) push(ofNth.end, { freq: 'MONTHLY', byDay: [nth.value] });
    }

    // [on] oct 12 every year, den 12 okt varje år
    const date = this.monthDate(text, pos);
    const ofYear = date && this.ofYear.read(text, space(text, date.end));
    if (date && ofYear) push(ofYear.end, { freq: 'YEARLY', ...date.value });
  }

  private afterEvery(text: string, pos: number | null, lead: 'every' | 'var', out: Draft[]): void {
    if (pos === null) return;
    const push = (end: number, rule: Omit<RecurrenceRule, 'interval'> & { interval?: number }) =>
      out.push({ end, rule: { interval: 1, ...rule }, basis: 'due' });

    // every last fri [of the month], varje sista fredag
    if (lead === 'every') {
      const nth = this.nthWeekday(text, pos);
      if (nth) {
        push(nth.end, { freq: 'MONTHLY', byDay: [nth.value] });
        const of = this.ofMonth.read(text, space(text, nth.end));
        if (of) push(of.end, { freq: 'MONTHLY', byDay: [nth.value] });
      }
    }

    // every [3] days …, var tredje dag …
    const count = this.count(text, pos);
    const unit = this.units.read(text, count ? space(text, count.end) : pos);
    if (unit) this.unitTail(text, unit.end, unit.value, count?.value.n ?? 1, out);

    // every other fri, var andra fredag
    if (count && (lead === 'var' || count.value.other)) {
      const days = this.days(text, space(text, count.end), this.weekdays);
      if (days) push(days.end, { freq: 'WEEKLY', interval: count.value.n, byDay: days.value });
    }

    // every weekday, varje vardag
    const workdays = this.workdays.read(text, pos);
    if (workdays)
      push(workdays.end, { freq: 'WEEKLY', byDay: WORKWEEK.map((weekday) => ({ weekday })) });

    // every mon and thu, varje måndag och torsdag
    const days = this.days(text, pos, this.weekdays);
    if (days) push(days.end, { freq: 'WEEKLY', byDay: days.value });

    // every 15th
    const day = this.dayNumber(text, pos, false);
    if (day) push(day.end, { freq: 'MONTHLY', byMonthDay: day.value });

    // every oct 12, varje 12 okt
    const date = this.monthDate(text, pos);
    if (date) push(date.end, { freq: 'YEARLY', ...date.value });
  }

  /** What may follow the unit of an interval: "after done", or the anchor of the period. */
  private unitTail(
    text: string,
    pos: number,
    freq: RecurrenceFreq,
    interval: number,
    out: Draft[],
  ): void {
    const push = (
      end: number,
      extra: Partial<RecurrenceRule> = {},
      basis: RecurrenceBasis = 'due',
    ) => out.push({ end, rule: { freq, interval, ...extra }, basis });
    push(pos);
    const p = space(text, pos);
    if (p === null) return;
    const after = this.afterDone.read(text, p);
    if (after) push(after.end, {}, 'completion');
    if (freq === 'WEEKLY') {
      const days = this.days(text, space(text, this.on.read(text, p)?.end ?? null), this.weekdays);
      if (days) push(days.end, { byDay: days.value });
    } else if (freq === 'MONTHLY') {
      const start = space(text, this.on.read(text, p)?.end ?? null) ?? p;
      const day = this.dayNumber(text, start, false);
      if (day) push(day.end, { byMonthDay: day.value });
      const nth = this.nthWeekday(text, start);
      if (nth) push(nth.end, { byDay: [nth.value] });
    } else if (freq === 'YEARLY') {
      const date = this.monthDate(text, p);
      if (date) push(date.end, date.value);
    }
  }

  private count(text: string, pos: number): Hit<{ n: number; other: boolean }> | null {
    const digits = execAt(DIGIT_COUNT, text, pos);
    if (digits) {
      const n = Number(digits[1]);
      return n >= 1 ? { end: DIGIT_COUNT.lastIndex, value: { n, other: false } } : null;
    }
    const word = this.counts.read(text, pos);
    if (!word) return null;
    const other = /^other$/i.test(text.slice(pos, word.end));
    return { end: word.end, value: { n: word.value, other } };
  }

  /** One or more weekdays joined by commas, "and", "och" or "&". */
  private days(
    text: string,
    pos: number | null,
    word: Word<number>,
  ): Hit<{ weekday: RuleWeekday }[]> | null {
    const first = word.read(text, pos);
    if (!first) return null;
    const days = [ruleWeekday(first.value)];
    let end = first.end;
    for (;;) {
      const joiner = execAt(JOINER, text, end);
      const next = joiner && word.read(text, JOINER.lastIndex);
      if (!next) break;
      days.push(ruleWeekday(next.value));
      end = next.end;
    }
    const unique = [...new Set(days)];
    return { end, value: unique.map((weekday) => ({ weekday })) };
  }

  /** "the 15th", "den 15:e", "15th"; with `bare`, also "den 15" and "15:e" alone. */
  private dayNumber(text: string, pos: number, bare: boolean): Hit<number> | null {
    const m = execAt(DAY_NUMBER, text, pos);
    if (!m) return null;
    const value = Number(m[2]);
    const marked = m[3] !== undefined || (bare && m[1] !== undefined);
    if (!marked || value < 1 || value > 31) return null;
    return { end: DAY_NUMBER.lastIndex, value };
  }

  /** "last fri", "the 2nd tuesday", "sista fredagen". */
  private nthWeekday(text: string, pos: number): Hit<{ weekday: RuleWeekday; nth: number }> | null {
    const start = execAt(THE, text, pos) ? THE.lastIndex : pos;
    const nth = this.nths.read(text, start);
    const weekday = nth && this.weekdays.read(text, space(text, nth.end));
    if (!nth || !weekday) return null;
    return { end: weekday.end, value: { weekday: ruleWeekday(weekday.value), nth: nth.value } };
  }

  private monthDate(
    text: string,
    pos: number | null,
  ): Hit<{ byMonth: number; byMonthDay: number }> | null {
    if (pos === null) return null;
    const m = execAt(this.monthDay, text, pos);
    if (!m) return null;
    const month = this.monthNames.get((m[1] ?? m[4]) as string).value;
    const day = Number(m[2] ?? m[3]);
    // A leap year, so Feb 29 is a valid anchor (it clamps to Feb 28 in other years).
    if (day < 1 || day > daysInMonth(2000, month)) return null;
    return { end: this.monthDay.lastIndex, value: { byMonth: month, byMonthDay: day } };
  }
}
