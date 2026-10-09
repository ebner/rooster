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

/**
 * `--due`/`--start`: an ISO date or a date phrase in either language ("fri", "tomorrow 14:00",
 * "nästa vecka"), read in the user's timezone and week start like the web's picker (ADR 0004).
 * Floating dates stay `YYYY-MM-DD` strings (hard rule 5).
 */
export function parseDateFlag(
  input: string,
  me: Pick<Me, 'timezone' | 'locale' | 'weekStart' | 'dateFormat'>,
  nowMs: number,
  flag: string,
): { date: string; time: string | null } {
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
 * carry the user's timezone. `--time` without a due date means today.
 */
export function applyDueFlags(
  current: DueUnit,
  flags: DueFlags,
  me: Pick<Me, 'timezone' | 'locale' | 'weekStart' | 'dateFormat'>,
  nowMs: number,
): DueUnit | null {
  if (flags.due === undefined && flags.time === undefined && flags.start === undefined) return null;
  const next: DueUnit = { ...current };
  if (flags.due !== undefined) {
    if (isNone(flags.due)) return { dueDate: null, dueTime: null, dueTz: null, startDate: null };
    const parsed = parseDateFlag(flags.due, me, nowMs, '--due');
    next.dueDate = parsed.date;
    if (parsed.time !== null) {
      next.dueTime = parsed.time;
      next.dueTz = me.timezone;
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
