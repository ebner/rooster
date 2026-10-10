import type { DateFormat, IsoDate, Locale, TimeFormat, WeekStart } from '@rooster/core/dates';
import type { RecurrenceBasis } from '@rooster/core/recurrence';

/**
 * A task's due fields as stored (05 §5): a floating `YYYY-MM-DD` date, an optional
 * `HH:MM` time, the IANA zone the time was set in, and an optional floating start
 * date (FR-DATE-2). `dueTz` is only meaningful when `dueTime` is set; `startDate`
 * only with a `dueDate`, and it is always before it (an equal start is no range).
 *
 * `startDate` may be left out by callers that do not show ranges; it then reads as
 * null. The picker always emits it.
 */
export interface DueValue {
  dueDate: IsoDate | null;
  dueTime: string | null;
  dueTz: string | null;
  startDate?: IsoDate | null | undefined;
  /**
   * P10 (FR-REC): the repeat rule and its basis, part of the due unit. Left out (undefined)
   * means "unchanged" in a patch; null stops the series. The picker only sets them when it
   * shows or changes a repeat.
   */
  recurrence?: string | null | undefined;
  recurrenceBasis?: RecurrenceBasis | null | undefined;
}

/** No due date (and so no start date). */
export const noDue: DueValue = { dueDate: null, dueTime: null, dueTz: null, startDate: null };

/**
 * Everything the date components need to label and pick dates for the signed-in
 * viewer. Build it with `useViewerDateContext()`; tests and the kitchen sink pass
 * fixed values so output is deterministic.
 */
export interface ViewerDateContext {
  /** The viewer's calendar date, `todayIn(timezone, nowMs)`. */
  today: IsoDate;
  /** The instant used for timed-overdue checks (ms epoch). */
  nowMs: number;
  /** UI language (labels, picker hints). */
  locale: Locale;
  /** 0 = Sunday, 1 = Monday. */
  weekStart: WeekStart;
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
  /** The viewer's IANA zone; new times are stored with it as `dueTz`. */
  timezone: string;
}

/** True when both describe the same due date, time, start date and repeat. */
export function sameDue(a: DueValue | null, b: DueValue | null): boolean {
  const x = a ?? noDue;
  const y = b ?? noDue;
  if (x.dueDate !== y.dueDate || x.dueTime !== y.dueTime) return false;
  if ((x.startDate ?? null) !== (y.startDate ?? null)) return false;
  if ((x.recurrence ?? null) !== (y.recurrence ?? null)) return false;
  if (x.recurrence && (x.recurrenceBasis ?? 'due') !== (y.recurrenceBasis ?? 'due')) return false;
  return x.dueTime === null || x.dueTz === y.dueTz;
}
