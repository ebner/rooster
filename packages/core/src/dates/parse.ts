/**
 * Natural-language date parser (02 §8). Pure: every function takes an explicit `today`.
 *
 * Decisions where 02 §8.2 is silent:
 * - `next <weekday>` / `nästa <veckodag>` / `på <veckodag>` equal the bare weekday (the next
 *   occurrence after today); only `this <weekday>` includes today.
 * - `weekend`/`helgen` is Saturday, or today on a Saturday or Sunday; `next weekend`/`nästa helg`
 *   is the Saturday after that one (on a Sunday: the coming Saturday).
 * - `end of week` is the last day of the week per `weekStart`; `end of month` its last day.
 * - `in N months` clamps to the month's last day (Jan 31 + 1 month = Feb 28/29).
 * - Title abbreviations of `today`/`tomorrow` (`tod`, `tom`, `tmr`) are ambiguous with names, so
 *   they obey the end-of-title rule; the full words match anywhere.
 * - A possessive ("tomorrow's") never matches; nor does any phrase governed by a recurrence word
 *   (`every`, `daily`, `varje`, `varannan`, …) until recurrence parsing lands (P10).
 * - A time suffix needs a connector (`at`, `@`, `kl`, `klockan`) unless it has minutes or am/pm.
 */
import {
  addDays,
  daysInMonth,
  diffDays,
  formatIsoDate,
  type IsoDate,
  isValidIsoDate,
  nextWeekday,
  parseIsoDate,
  startOfWeek,
  weekdayOf,
} from './iso.ts';
import {
  DATE_PREFIXES,
  DAY_WORDS,
  END_OF,
  MONTHS,
  NEXT_MONTH,
  NEXT_WEEK,
  NUMBER_WORDS,
  RECURRENCE_FILLERS,
  RECURRENCE_TRIGGERS,
  RELATIVE_INTROS,
  type RelativeUnit,
  TIME_CONNECTORS,
  UNITS,
  type VocabEntry,
  WEEKDAY_PREFIXES,
  WEEKDAYS,
  WEEKENDS,
} from './parse-vocab.ts';
import {
  escapeSpans,
  inlineTokenSpans,
  isTitleTail,
  overlapsAny,
  type Span,
} from './tokens-spans.ts';

export type ParseLocale = 'en' | 'sv';

export interface DateParseContext {
  /** `YYYY-MM-DD` in the user's timezone. */
  today: string;
  /** Title mode: this language's abbreviations plus English full words. Picker: both, fully. */
  locale: ParseLocale;
  /** 0 = Sunday, 1 = Monday. */
  weekStart: 0 | 1;
  /** Only used for numeric slash dates in picker mode. */
  dateFormat: 'MMM d' | 'd MMM';
}

export interface DateParseResult {
  date: string;
  /** `HH:MM` or null. */
  time: string | null;
}

export interface TitleDateMatch extends DateParseResult {
  /** UTF-16 offsets of the matched phrase in the title. */
  start: number;
  end: number;
  text: string;
}

/**
 * - `title`: 02 §8.1 vocabulary gating (UI language + English full words); no slash dates.
 * - `picker`: both languages fully, slash dates per `dateFormat`.
 * - `tail`: both languages fully, no slash dates; used to recognise a date after `>Group`.
 */
type Mode = 'title' | 'picker' | 'tail';

interface Resolved {
  date: IsoDate;
  /** False for phrases that only match at the end of a title (02 §8.1 position rule). */
  anywhere: boolean;
}

interface Rule {
  re: RegExp;
  resolve: (m: RegExpExecArray, ctx: DateParseContext) => Resolved | null;
}

interface Grammar {
  rules: Rule[];
  connectorTime: RegExp;
  bareTime: RegExp;
}

interface Candidate extends Span, DateParseResult {
  anywhere: boolean;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;
// Word boundary after a phrase. A trailing apostrophe + letter ("tomorrow's") also blocks, so a
// possessive is never read as a date.
const BOUNDARY = String.raw`(?![\p{L}\p{N}_])(?!['’]\p{L})`;
const AM_PM = String.raw`([ap])\.?m\.?`;
const ORDINAL = '(?:st|nd|rd|th|:e)?';

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ');
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isActive(entry: VocabEntry<unknown>, mode: Mode, locale: ParseLocale): boolean {
  if (mode !== 'title') return true;
  return entry.lang === locale || (entry.lang === 'en' && !entry.abbr);
}

class Vocab<T> {
  readonly pattern: string;
  private readonly byText = new Map<string, VocabEntry<T>>();

  constructor(all: readonly VocabEntry<T>[], mode: Mode, locale: ParseLocale) {
    for (const e of all) if (isActive(e, mode, locale)) this.byText.set(e.text, e);
    this.pattern = [...this.byText.keys()]
      .sort((a, b) => b.length - a.length)
      .map((t) => escapeRe(t).replace(/ /g, String.raw`\s+`))
      .join('|');
  }

  /** The entry for text the pattern matched (so it always exists). */
  get(text: string): VocabEntry<T> {
    return this.byText.get(normalise(text)) as VocabEntry<T>;
  }
}

function sticky(source: string): RegExp {
  return new RegExp(source + BOUNDARY, 'iuy');
}

function addMonths(date: IsoDate, n: number): IsoDate {
  const { year, month, day } = parseIsoDate(date);
  const index = month - 1 + n;
  const y = year + Math.floor(index / 12);
  const m = (index % 12) + 1;
  return formatIsoDate({ year: y, month: m, day: Math.min(day, daysInMonth(y, m)) });
}

function addRelative(today: IsoDate, n: number, unit: RelativeUnit): IsoDate {
  if (unit === 'm') return addMonths(today, n);
  return addDays(today, unit === 'w' ? n * 7 : n);
}

function firstOfNextMonth(today: IsoDate): IsoDate {
  const { year, month } = parseIsoDate(addMonths(today, 1));
  return formatIsoDate({ year, month, day: 1 });
}

function endOfMonth(today: IsoDate): IsoDate {
  const { year, month } = parseIsoDate(today);
  return formatIsoDate({ year, month, day: daysInMonth(year, month) });
}

function weekendDate(today: IsoDate, which: 'this' | 'next'): IsoDate {
  // On a Sunday "this weekend" is today, and the next weekend starts six days later.
  if (weekdayOf(today) === 0) return which === 'this' ? today : nextWeekday(today, 6);
  const saturday = nextWeekday(today, 6, { includeToday: true });
  return which === 'this' ? saturday : addDays(saturday, 7);
}

/** An explicit day/month; without a year, the next occurrence today or later (02 §8.2). */
function explicitDate(
  today: IsoDate,
  month: number,
  day: number,
  yearText: string | undefined,
): IsoDate | null {
  if (month < 1 || month > 12 || day < 1) return null;
  if (yearText !== undefined) {
    const year = Number(yearText);
    return day <= daysInMonth(year, month) ? formatIsoDate({ year, month, day }) : null;
  }
  const { year } = parseIsoDate(today);
  // Eight years always contain a Feb 29.
  for (let y = year; y <= year + 8; y++) {
    if (day > daysInMonth(y, month)) continue;
    const date = formatIsoDate({ year: y, month, day });
    if (diffDays(date, today) >= 0) return date;
  }
  return null;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function toTime(
  hourText: string,
  minuteText: string | undefined,
  amPm: string | undefined,
): string | null {
  let hour = Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  if (minute > 59) return null;
  if (amPm !== undefined) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (amPm.toLowerCase() === 'p' ? 12 : 0);
  } else if (hour > 23) {
    return null;
  }
  return `${pad2(hour)}:${pad2(minute)}`;
}

function buildGrammar(mode: Mode, locale: ParseLocale): Grammar {
  const v = <T>(all: readonly VocabEntry<T>[]) => new Vocab(all, mode, locale);
  const dayWords = v(DAY_WORDS);
  const weekdays = v(WEEKDAYS);
  const months = v(MONTHS);
  const weekdayPrefixes = v(WEEKDAY_PREFIXES);
  const datePrefix = `(?:(?:${v(DATE_PREFIXES).pattern})\\s+)?`;
  const weekdayLead = `(?:(?:${weekdays.pattern}),?\\s+)?`;
  const year = String.raw`(?:,?\s+(\d{4}))?`;
  const weekends = v(WEEKENDS);
  const endOf = v(END_OF);
  const numbers = v(NUMBER_WORDS);
  const units = v(UNITS);

  const rules: Rule[] = [
    {
      re: sticky(`(${dayWords.pattern})`),
      resolve: (m, ctx) => {
        const e = dayWords.get(m[1] as string);
        // Abbreviations ("tom") are ambiguous with names, so they obey the end-of-title rule.
        return { date: addDays(ctx.today, e.value), anywhere: !e.abbr };
      },
    },
    {
      re: sticky(`(?:(${weekdayPrefixes.pattern})\\s+)?(${weekdays.pattern})`),
      resolve: (m, ctx) => {
        const includeToday = m[1] !== undefined && weekdayPrefixes.get(m[1]).value === 'this';
        const weekday = weekdays.get(m[2] as string).value;
        return { date: nextWeekday(ctx.today, weekday, { includeToday }), anywhere: false };
      },
    },
    {
      re: sticky(`(?:${v(NEXT_WEEK).pattern})`),
      resolve: (_m, ctx) => ({ date: nextWeekday(ctx.today, ctx.weekStart), anywhere: false }),
    },
    {
      re: sticky(`(${weekends.pattern})`),
      resolve: (m, ctx) => ({
        date: weekendDate(ctx.today, weekends.get(m[1] as string).value),
        anywhere: false,
      }),
    },
    {
      re: sticky(`(?:${v(NEXT_MONTH).pattern})`),
      resolve: (_m, ctx) => ({ date: firstOfNextMonth(ctx.today), anywhere: false }),
    },
    {
      re: sticky(`(${endOf.pattern})`),
      resolve: (m, ctx) => ({
        date:
          endOf.get(m[1] as string).value === 'week'
            ? addDays(startOfWeek(ctx.today, ctx.weekStart), 6)
            : endOfMonth(ctx.today),
        anywhere: false,
      }),
    },
    {
      re: sticky(
        `(?:${v(RELATIVE_INTROS).pattern})\\s+(\\d{1,3}|${numbers.pattern})\\s+(${units.pattern})`,
      ),
      resolve: (m, ctx) => {
        const count = m[1] as string;
        const n = /^\d/.test(count) ? Number(count) : numbers.get(count).value;
        return {
          date: addRelative(ctx.today, n, units.get(m[2] as string).value),
          anywhere: false,
        };
      },
    },
    {
      re: sticky(String.raw`\+(\d{1,3})\s?([dwm])`),
      resolve: (m, ctx) => ({
        date: addRelative(ctx.today, Number(m[1]), (m[2] as string).toLowerCase() as RelativeUnit),
        anywhere: false,
      }),
    },
    {
      re: sticky(`${datePrefix}${weekdayLead}(${months.pattern})\\s+(\\d{1,2})${ORDINAL}${year}`),
      resolve: (m, ctx) => explicit(ctx, months.get(m[1] as string).value, m[2], m[3]),
    },
    {
      re: sticky(
        `${datePrefix}${weekdayLead}(\\d{1,2})${ORDINAL}(?:\\s+of)?\\s+(${months.pattern})${year}`,
      ),
      resolve: (m, ctx) => explicit(ctx, months.get(m[2] as string).value, m[1], m[3]),
    },
    {
      re: sticky(String.raw`${datePrefix}(\d{4}-\d{2}-\d{2})`),
      resolve: (m) => {
        const date = m[1] as string;
        return isValidIsoDate(date) ? { date, anywhere: true } : null;
      },
    },
  ];
  if (mode === 'picker') {
    rules.push({
      re: sticky(String.raw`(\d{1,2})/(\d{1,2})(?:/(\d{4}|\d{2}))?`),
      resolve: (m, ctx) => {
        const [a, b] = [Number(m[1]), Number(m[2])];
        const [month, day] = ctx.dateFormat === 'MMM d' ? [a, b] : [b, a];
        const yearText = m[3]?.length === 2 ? `20${m[3]}` : m[3];
        const date = explicitDate(ctx.today, month, day, yearText);
        return date ? { date, anywhere: true } : null;
      },
    });
  }

  return {
    rules,
    connectorTime: sticky(
      `(?:${v(TIME_CONNECTORS).pattern})\\s*(\\d{1,2})(?:[:.](\\d{2}))?(?:\\s*${AM_PM})?`,
    ),
    bareTime: sticky(String.raw`(\d{1,2})(?::(\d{2})(?:\s*${AM_PM})?|\s*${AM_PM})`),
  };
}

function explicit(
  ctx: DateParseContext,
  month: number,
  dayText: string | undefined,
  yearText: string | undefined,
): Resolved | null {
  const date = explicitDate(ctx.today, month, Number(dayText), yearText);
  return date ? { date, anywhere: true } : null;
}

const grammars = new Map<string, Grammar>();

function grammarFor(mode: Mode, locale: ParseLocale): Grammar {
  const key = mode === 'title' ? `title:${locale}` : mode;
  let grammar = grammars.get(key);
  if (!grammar) {
    grammar = buildGrammar(mode, locale);
    grammars.set(key, grammar);
  }
  return grammar;
}

function execAt(re: RegExp, text: string, pos: number): RegExpExecArray | null {
  re.lastIndex = pos;
  return re.exec(text);
}

/** A time phrase starting exactly at `pos`. */
function timeAt(text: string, pos: number, g: Grammar): { end: number; time: string } | null {
  const c = execAt(g.connectorTime, text, pos);
  if (c) {
    const time = toTime(c[1] as string, c[2], c[3]);
    return time ? { end: pos + c[0].length, time } : null;
  }
  const b = execAt(g.bareTime, text, pos);
  if (!b) return null;
  const time = toTime(b[1] as string, b[2], b[3] ?? b[4]);
  return time ? { end: pos + b[0].length, time } : null;
}

/** Every phrase starting at `pos`: each matching date rule, with and without a time suffix. */
function candidatesAt(text: string, pos: number, g: Grammar, ctx: DateParseContext): Candidate[] {
  const out: Candidate[] = [];
  for (const rule of g.rules) {
    const m = execAt(rule.re, text, pos);
    const resolved = m && rule.resolve(m, ctx);
    if (!resolved) continue;
    const base: Candidate = {
      start: pos,
      end: rule.re.lastIndex,
      date: resolved.date,
      time: null,
      anywhere: resolved.anywhere,
    };
    out.push(base);
    let timePos = base.end;
    while (/\s/.test(text.charAt(timePos))) timePos++;
    const time = timePos > base.end ? timeAt(text, timePos, g) : null;
    if (time) out.push({ ...base, end: time.end, time: time.time });
  }
  return out;
}

function longest(candidates: Candidate[]): Candidate | null {
  let best: Candidate | null = null;
  for (const c of candidates) if (!best || c.end > best.end) best = c;
  return best;
}

function wholePhrase(input: string, mode: Mode, ctx: DateParseContext): DateParseResult | null {
  const text = input.trim();
  const g = grammarFor(mode, ctx.locale);
  const best = longest(candidatesAt(text, 0, g, ctx).filter((c) => c.end === text.length));
  if (best) return { date: best.date, time: best.time };
  if (mode !== 'picker') return null;
  // A lone time in the picker means today at that time.
  const time = timeAt(text, 0, g);
  return time && time.end === text.length ? { date: ctx.today, time: time.time } : null;
}

/** Picker input: the whole input must be a date phrase (optionally with time). */
export function parseDatePhrase(input: string, ctx: DateParseContext): DateParseResult | null {
  return wholePhrase(input, 'picker', ctx);
}

const TAIL_CONTEXT: DateParseContext = {
  today: '2000-01-01',
  locale: 'en',
  weekStart: 1,
  dateFormat: 'd MMM',
};

/** True when `text` is exactly one date phrase in either language (no slash dates, no lone time). */
export function isDatePhrase(text: string): boolean {
  return wholePhrase(text, 'tail', TAIL_CONTEXT) !== null;
}

const WORDS_RE = /[\p{L}\p{N}:]+/gu;
const NUMERIC_RE = /^\d+(?:st|nd|rd|th|:e)?$/;

/** Is the phrase governed by a recurrence word ("every mon", "varje måndag", "12 okt varje år")? */
function inRecurrence(title: string, c: Span): boolean {
  const before = title.slice(0, c.start).toLowerCase().match(WORDS_RE) ?? [];
  for (let i = before.length - 1; i >= 0; i--) {
    const word = before[i] as string;
    if (RECURRENCE_TRIGGERS.has(word)) return true;
    if (!RECURRENCE_FILLERS.has(word) && !NUMERIC_RE.test(word)) break;
  }
  const next = /^\s*([\p{L}]+)/u.exec(title.slice(c.end));
  return next !== null && RECURRENCE_TRIGGERS.has((next[1] as string).toLowerCase());
}

/**
 * Title mode: the LAST valid match per the 02 §8.1 position rule; null if none. `ignored` are
 * ranges the user cancelled; nothing matches inside them, backtick escapes or inline tokens.
 */
export function findDateInTitle(
  title: string,
  ctx: DateParseContext,
  ignored: ReadonlyArray<{ start: number; end: number }> = [],
): TitleDateMatch | null {
  const g = grammarFor('title', ctx.locale);
  const blocked = [...escapeSpans(title), ...inlineTokenSpans(title), ...ignored];
  let found: Candidate | null = null;
  let pos = 0;
  while (pos < title.length) {
    if (pos > 0 && WORD_CHAR.test(title.charAt(pos - 1))) {
      pos++;
      continue;
    }
    const best = longest(
      candidatesAt(title, pos, g, ctx).filter(
        (c) =>
          !overlapsAny(c, blocked) &&
          (c.anywhere || isTitleTail(title.slice(c.end))) &&
          !inRecurrence(title, c),
      ),
    );
    if (best) {
      found = best;
      pos = best.end;
    } else {
      pos++;
    }
  }
  if (!found) return null;
  const { start, end, date, time } = found;
  return { date, time, start, end, text: title.slice(start, end) };
}
