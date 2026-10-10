import { isValidIsoDate, isValidTime, parseDatePhrase, todayIn } from '@rooster/core/dates';
import type { Me } from './api.ts';
import { CliError, EXIT } from './errors.ts';
import { t } from './i18n.ts';

export interface DueUnit {
  dueDate: string | null;
  dueTime: string | null;
  dueTz: string | null;
  startDate: string | null;
}

export type RecurrenceBasis = 'due' | 'completion';

/**
 * A due unit plus, when a phrase named one, the recurrence rule (P10, ADR 0049 §1.8). Absent
 * recurrence fields mean "keep the task's rule", as the PATCH contract reads them.
 */
export interface DueChange extends DueUnit {
  recurrence?: string | null;
  recurrenceBasis?: RecurrenceBasis | null;
}

type DateMe = Pick<Me, 'timezone' | 'locale' | 'weekStart' | 'dateFormat'>;

export interface ParsedDate {
  date: string;
  time: string | null;
  /** P10: the phrase was a recurrence ("every mon"); `date` is its first occurrence. */
  recurrence?: { rule: string; basis: RecurrenceBasis };
}

/**
 * `--due`/`--start`: an ISO date or a date phrase in either language ("fri", "tomorrow 14:00",
 * "nästa vecka"), read in the user's timezone and week start like the web's picker (ADR 0004).
 * Floating dates stay `YYYY-MM-DD` strings (hard rule 5).
 */
export function parseDateFlag(input: string, me: DateMe, nowMs: number, flag: string): ParsedDate {
  const text = input.trim();
  if (isValidIsoDate(text)) return { date: text, time: null };
  const parsed = parseDatePhrase(text, {
    today: todayIn(me.timezone, nowMs),
    locale: me.locale,
    weekStart: me.weekStart,
    dateFormat: me.dateFormat,
  });
  if (parsed === null) throw new CliError(EXIT.conflict, t('date.invalid', { flag, value: input }));
  return parsed;
}

export function parseTimeFlag(input: string): string {
  const text = input.trim();
  const match = /^(\d{1,2})[:.](\d{2})$/.exec(text);
  const time = match ? `${match[1]?.padStart(2, '0')}:${match[2]}` : text;
  if (!isValidTime(time)) throw new CliError(EXIT.conflict, t('date.badTime', { value: input }));
  return time;
}

export const isNone = (value: string) =>
  ['none', 'null', '-', 'ingen', 'inget'].includes(value.trim().toLowerCase());

export interface DueFlags {
  due?: string | undefined;
  time?: string | undefined;
  start?: string | undefined;
}

/**
 * The due unit after applying `--due`, `--time` and `--start` to `current` (05 §4.4: date,
 * time, timezone and start date change together). Null when no flag was given. New times
 * carry the user's timezone. `--time` without a due date means today. A recurrence phrase in
 * `--due` ("every mon") also sets the rule (P10); any other date keeps the task's rule.
 */
export function applyDueFlags(
  current: DueUnit,
  flags: DueFlags,
  me: DateMe,
  nowMs: number,
): DueChange | null {
  if (flags.due === undefined && flags.time === undefined && flags.start === undefined) return null;
  // Only the four fields of the due unit: `current` may be a whole task, whose other fields
  // (title, description) must never ride along into a patch.
  const next: DueChange = {
    dueDate: current.dueDate,
    dueTime: current.dueTime,
    dueTz: current.dueTz,
    startDate: current.startDate,
  };
  if (flags.due !== undefined) {
    if (isNone(flags.due)) return { dueDate: null, dueTime: null, dueTz: null, startDate: null };
    const parsed = parseDateFlag(flags.due, me, nowMs, '--due');
    next.dueDate = parsed.date;
    if (parsed.time !== null) {
      next.dueTime = parsed.time;
      next.dueTz = me.timezone;
    }
    if (parsed.recurrence !== undefined) {
      next.recurrence = parsed.recurrence.rule;
      next.recurrenceBasis = parsed.recurrence.basis;
    }
  }
  if (flags.time !== undefined) {
    if (isNone(flags.time)) {
      next.dueTime = null;
      next.dueTz = null;
    } else {
      next.dueTime = parseTimeFlag(flags.time);
      next.dueTz = me.timezone;
      next.dueDate ??= todayIn(me.timezone, nowMs);
    }
  }
  if (flags.start !== undefined) {
    next.startDate = isNone(flags.start)
      ? null
      : parseDateFlag(flags.start, me, nowMs, '--start').date;
  }
  if (next.dueDate === null) {
    if (next.startDate !== null) throw new CliError(EXIT.conflict, t('date.startNeedsDue'));
    next.dueTime = null;
    next.dueTz = null;
  } else if (next.startDate !== null && next.startDate > next.dueDate) {
    throw new CliError(EXIT.conflict, t('date.startAfterDue'));
  }
  if (next.dueTime === null) next.dueTz = null;
  return next;
}

/**
 * `--repeat <phrase|none>` (P10, FR-REC-2): the rule of a recurrence phrase ("every mon",
 * "every 3 days after done", "varje månad"), or `none` to stop repeating.
 *
 * `anchor` is the due date the task will have (its own, `--due`'s or the title's). It is kept,
 * and the phrase is read as if on that day, so the anchors a phrase leaves implicit come from
 * the due date: "monthly" on a task due Nov 1 is `BYMONTHDAY=1`, never today's day of the
 * month. Without one, the phrase is read from today and its first occurrence becomes the due
 * date, since a rule needs one.
 */
export function applyRepeatFlag(
  anchor: string | null,
  input: string,
  me: DateMe,
  nowMs: number,
): Partial<DueChange> {
  if (isNone(input)) return { recurrence: null, recurrenceBasis: null };
  const text = input.trim();
  const today = anchor !== null && isValidIsoDate(anchor) ? anchor : todayIn(me.timezone, nowMs);
  const parsed = isValidIsoDate(text)
    ? null
    : parseDatePhrase(text, {
        today,
        locale: me.locale,
        weekStart: me.weekStart,
        dateFormat: me.dateFormat,
      });
  if (parsed?.recurrence === undefined || (parsed.time !== null && !isValidTime(parsed.time))) {
    throw new CliError(EXIT.conflict, t('repeat.invalid', { value: input }));
  }
  const rule = { recurrence: parsed.recurrence.rule, recurrenceBasis: parsed.recurrence.basis };
  if (anchor !== null) return rule;
  return {
    dueDate: parsed.date,
    dueTime: parsed.time,
    dueTz: parsed.time === null ? null : me.timezone,
    startDate: null,
    ...rule,
  };
}
