import {
  type DateParseContext,
  type DateParseResult,
  daysInMonth,
  diffDays,
  formatIsoDate,
  type IsoDate,
  parseDatePhrase,
  parseIsoDate,
} from '@rooster/core/dates';

export type ParseContext = DateParseContext;
export type ParsedDate = DateParseResult;

/**
 * The date picker's parser (02 §7, §8.1): both languages fully, plus numeric slash
 * dates. Swedish labels are always day-first (`formatRelative` ignores `MMM d` for
 * Swedish), so `12/10` is read day-first too. Returns null when the text is not a date.
 */
export function parsePickerInput(input: string, ctx: ParseContext): ParsedDate | null {
  return parseDatePhrase(input, ctx.locale === 'sv' ? { ...ctx, dateFormat: 'd MMM' } : ctx);
}

/** A start–due range typed in the picker ("oct 10 - 12", "10–12 okt", "fri to next tue"). */
export interface ParsedRange {
  start: IsoDate;
  /** The due date (the end of the range). */
  date: IsoDate;
  /** The due time, when the end phrase has one. */
  time: string | null;
}

/**
 * Separators between the two ends, tried in order: words, dashes with spaces, an en or
 * em dash, then a bare hyphen between day numbers ("10-12 okt"). A plain hyphen inside
 * an ISO date never splits, because a whole-input date wins first.
 */
const rangeSeparators: readonly RegExp[] = [
  /\s+(?:to|till|until|tills)\s+/i,
  /\s*[–—]\s*/,
  /\s+-\s+/,
  /(?<=\d)-(?=\d{1,2}(?:\s|$))/,
];

const bareDay = /^(\d{1,2})(?:st|nd|rd|th|:e|\.)?$/i;

function withDay(anchor: IsoDate, day: number, monthShift: number): IsoDate | null {
  const { year, month } = parseIsoDate(anchor);
  const index = year * 12 + (month - 1) + monthShift;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return day >= 1 && day <= daysInMonth(y, m) ? formatIsoDate({ year: y, month: m, day }) : null;
}

/** One end; a bare day number borrows the month of the other end. */
function parseEnds(left: string, right: string, ctx: ParseContext): ParsedRange | null {
  const leftDay = bareDay.exec(left)?.[1];
  const rightDay = bareDay.exec(right)?.[1];
  if (leftDay && rightDay) return null;
  if (rightDay) {
    const start = parsePickerInput(left, ctx);
    if (!start) return null;
    const day = Number(rightDay);
    const date = withDay(start.date, day, day < parseIsoDate(start.date).day ? 1 : 0);
    return date ? { start: start.date, date, time: null } : null;
  }
  const end = parsePickerInput(right, ctx);
  if (!end) return null;
  if (leftDay) {
    const day = Number(leftDay);
    const start = withDay(end.date, day, day > parseIsoDate(end.date).day ? -1 : 0);
    return start ? { start, date: end.date, time: end.time } : null;
  }
  const start = parsePickerInput(left, ctx);
  return start ? { start: start.date, date: end.date, time: end.time } : null;
}

/**
 * Reads a date range from the picker input (FR-DATE-2). Returns null when the text is
 * not a range (a single date included). Reversed ends are swapped, so the start is
 * always before the due date; equal ends are not a range.
 */
export function parseRangeInput(input: string, ctx: ParseContext): ParsedRange | null {
  const text = input.trim();
  if (!text || parsePickerInput(text, ctx)) return null;
  for (const separator of rangeSeparators) {
    const parts = text.split(separator);
    if (parts.length !== 2) continue;
    const [left = '', right = ''] = parts.map((part) => part.trim());
    if (!left || !right) continue;
    const range = parseEnds(left, right, ctx);
    if (!range) continue;
    const order = diffDays(range.start, range.date);
    if (order === 0) continue;
    return order < 0 ? range : { start: range.date, date: range.start, time: range.time };
  }
  return null;
}
