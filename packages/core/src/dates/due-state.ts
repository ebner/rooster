import { TZDate } from '@date-fns/tz';
import { diffDays, type IsoDate, parseIsoDate, parseTime } from './iso.ts';

export type DueState = 'overdue' | 'today' | 'tomorrow' | 'thisWeek' | 'later' | 'done' | 'none';

export interface DueInput {
  dueDate: IsoDate | null;
  /** `HH:MM` */
  dueTime?: string | null;
  /** IANA zone the time was set in. */
  dueTz?: string | null;
  completed: boolean;
}

export interface DueContext {
  /** The viewer's today (`todayIn(viewerTz, nowMs)`). */
  today: IsoDate;
  nowMs: number;
  viewerTz: string;
}

/** The instant (ms epoch) of a timed due, interpreted in `tz`. */
export function dueInstant(dueDate: IsoDate, dueTime: string, tz: string): number {
  const { year, month, day } = parseIsoDate(dueDate);
  const { hour, minute } = parseTime(dueTime);
  const instant = new TZDate(year, month - 1, day, hour, minute, tz).getTime();
  if (Number.isNaN(instant)) throw new RangeError(`Invalid time zone: ${tz}`);
  return instant;
}

/** Due-date state driving the label colour (03 §2.3). */
export function dueState(task: DueInput, ctx: DueContext): DueState {
  if (task.completed) return 'done';
  if (!task.dueDate) return 'none';

  const days = diffDays(task.dueDate, ctx.today);
  if (days < 0) return 'overdue';
  // A timed due is overdue once its instant has passed. The date part stays floating
  // (compared with the viewer's today), so when the viewer is behind `dueTz` the instant
  // can pass while the label still reads "Tomorrow"; overdue wins in that case.
  if (task.dueTime) {
    const instant = dueInstant(task.dueDate, task.dueTime, task.dueTz ?? ctx.viewerTz);
    if (ctx.nowMs > instant) return 'overdue';
  }
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days <= 6) return 'thisWeek';
  return 'later';
}
