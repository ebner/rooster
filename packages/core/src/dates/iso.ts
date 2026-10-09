import { TZDate } from '@date-fns/tz';

/** A floating calendar date, `YYYY-MM-DD`. */
export type IsoDate = string;
/** 0 = Sunday … 6 = Saturday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type WeekStart = 0 | 1;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface DateParts {
  year: number;
  month: number;
  day: number;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function matchParts(value: string): DateParts | null {
  const m = ISO_DATE_RE.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

export function isValidIsoDate(value: unknown): value is IsoDate {
  return typeof value === 'string' && matchParts(value) !== null;
}

export function parseIsoDate(value: IsoDate): DateParts {
  const parts = matchParts(value);
  if (!parts) throw new RangeError(`Invalid ISO date: ${value}`);
  return parts;
}

export function isValidTime(value: unknown): value is string {
  return typeof value === 'string' && TIME_RE.test(value);
}

/** Parses `HH:MM` (00:00–23:59). */
export function parseTime(value: string): { hour: number; minute: number } {
  const m = TIME_RE.exec(value);
  if (!m) throw new RangeError(`Invalid time: ${value}`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

export function formatIsoDate({ year, month, day }: DateParts): IsoDate {
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

// Proleptic Gregorian day numbers (days since 1970-01-01), from Howard Hinnant's
// civil-calendar algorithms. Integer-only, so there is no timezone or DST involvement.
function toDayNumber({ year, month, day }: DateParts): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function fromDayNumber(n: number): DateParts {
  const z = n + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return { year, month, day };
}

/** The viewer's calendar date at instant `now` (ms epoch) in IANA zone `tz`. */
export function todayIn(tz: string, now: number): IsoDate {
  const d = new TZDate(now, tz);
  if (Number.isNaN(d.getTime()))
    throw new RangeError(`Invalid time zone or instant: ${tz}, ${now}`);
  return formatIsoDate({ year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() });
}

const DAY_MS = 86_400_000;
const offsetFormats = new Map<string, Intl.DateTimeFormat>();

/** How far zone `tz` is ahead of UTC (ms) at `instant`. Throws RangeError for an unknown zone. */
function zoneOffsetMs(tz: string, instant: number): number {
  let format = offsetFormats.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    offsetFormats.set(tz, format);
  }
  const part: Record<string, number> = {};
  for (const { type, value } of format.formatToParts(instant)) part[type] = Number(value);
  const wall = Date.UTC(
    part.year as number,
    (part.month as number) - 1,
    part.day as number,
    part.hour as number,
    part.minute as number,
    part.second as number,
  );
  return wall - (instant - (((instant % 1000) + 1000) % 1000));
}

/**
 * The instant (ms epoch) at which zone `tz` shows the given wall-clock time. Uses only the
 * zone's own rules, never the host's time zone. A time that occurs twice (clocks go back)
 * resolves to its first occurrence; one that does not exist (clocks go forward) is moved
 * forward by the gap, so 02:30 on a spring-forward night becomes 03:30.
 */
export function zonedWallTimeToInstant(
  date: DateParts,
  hour: number,
  minute: number,
  tz: string,
): number {
  const wall = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const before = zoneOffsetMs(tz, wall - DAY_MS);
  const after = zoneOffsetMs(tz, wall + DAY_MS);
  const valid = [wall - before, wall - after].filter((at) => zoneOffsetMs(tz, at) === wall - at);
  return valid.length > 0 ? Math.min(...valid) : wall - before;
}

export function addDays(date: IsoDate, n: number): IsoDate {
  return formatIsoDate(fromDayNumber(toDayNumber(parseIsoDate(date)) + n));
}

/** Whole days from `b` to `a` (`a - b`): `diffDays('2026-10-12', '2026-10-10') === 2`. */
export function diffDays(a: IsoDate, b: IsoDate): number {
  return toDayNumber(parseIsoDate(a)) - toDayNumber(parseIsoDate(b));
}

export function weekdayOf(date: IsoDate): Weekday {
  // 1970-01-01 was a Thursday (4).
  return ((((toDayNumber(parseIsoDate(date)) + 4) % 7) + 7) % 7) as Weekday;
}

export function startOfWeek(date: IsoDate, weekStart: WeekStart): IsoDate {
  return addDays(date, -((weekdayOf(date) - weekStart + 7) % 7));
}

/**
 * The next `weekday` after `from` (02 §8.2: "the next occurrence after today"); with
 * `includeToday`, `from` itself is returned when it already falls on `weekday`.
 */
export function nextWeekday(
  from: IsoDate,
  weekday: Weekday,
  options: { includeToday?: boolean } = {},
): IsoDate {
  let delta = (weekday - weekdayOf(from) + 7) % 7;
  if (delta === 0 && !options.includeToday) delta = 7;
  return addDays(from, delta);
}
