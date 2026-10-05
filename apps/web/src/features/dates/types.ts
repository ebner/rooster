import type { DateFormat, IsoDate, Locale, TimeFormat, WeekStart } from '@rooster/core/dates';

/**
 * A task's due fields as stored (05 §5): a floating `YYYY-MM-DD` date, an optional
 * `HH:MM` time, and the IANA zone the time was set in. `dueTz` is only meaningful
 * when `dueTime` is set.
 */
export interface DueValue {
  dueDate: IsoDate | null;
  dueTime: string | null;
  dueTz: string | null;
}

/** No due date. */
export const noDue: DueValue = { dueDate: null, dueTime: null, dueTz: null };

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

/** True when both describe the same due date and time. */
export function sameDue(a: DueValue | null, b: DueValue | null): boolean {
  const x = a ?? noDue;
  const y = b ?? noDue;
  if (x.dueDate !== y.dueDate || x.dueTime !== y.dueTime) return false;
  return x.dueTime === null || x.dueTz === y.dueTz;
}
