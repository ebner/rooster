/**
 * Task reminders (FR-REM, 05 §3 `task_reminder`, ADR 0049). Pure: callers pass the task's due
 * fields and the reminder owner's timezone and default reminder time.
 */

import { dueInstant } from './dates/due-state.ts';
import { isValidIsoDate, isValidTime } from './dates/iso.ts';
import { REMINDER_OFFSET_MAX } from './limits.ts';

export type ReminderKind = 'relative' | 'absolute';

/** What a client asks for: minutes before the due moment, or an absolute instant. */
export type ReminderSpec = { offsetMinutes: number } | { at: number };

export interface ReminderDueFields {
  dueDate: string | null;
  dueTime: string | null;
  dueTz: string | null;
}

export interface ReminderOwner {
  /** The owner's IANA timezone (`user.timezone`). */
  timezone: string;
  /** `prefs.allDayReminderTime`, `HH:MM`. */
  allDayReminderTime: string;
}

/**
 * The due moment (FR-REM-2): a timed task's due date and time in its `dueTz`; an all-day
 * task's due date at the owner's default reminder time in the owner's timezone. Null without
 * a due date.
 */
export function dueMoment(task: ReminderDueFields, owner: ReminderOwner): number | null {
  if (task.dueDate === null || !isValidIsoDate(task.dueDate)) return null;
  if (task.dueTime !== null && task.dueTz !== null) {
    return dueInstant(task.dueDate, task.dueTime, task.dueTz);
  }
  const time = isValidTime(owner.allDayReminderTime) ? owner.allDayReminderTime : '09:00';
  return dueInstant(task.dueDate, time, owner.timezone);
}

/**
 * A reminder's resolved instant (`task_reminder.fire_at`): absolute reminders fire at their
 * instant; relative ones `offsetMinutes` before the due moment, and are dormant (null) while
 * the task has no due date (ADR 0049).
 */
export function resolveFireAt(
  reminder: { kind: ReminderKind; offsetMinutes: number | null; remindAt: number | null },
  task: ReminderDueFields,
  owner: ReminderOwner,
): number | null {
  if (reminder.kind === 'absolute') return reminder.remindAt;
  const due = dueMoment(task, owner);
  if (due === null || reminder.offsetMinutes === null) return null;
  return due - reminder.offsetMinutes * 60_000;
}

const TOKEN = /^(?:(\d{1,5})([mhd])|due)$/i;
const UNIT_MINUTES = { m: 1, h: 60, d: 1440 } as const;

/**
 * A reminder token without its `!` (`15m`, `2h`, `1d`, `due`; 02 §8.1) as minutes before the
 * due moment, or null when it is not one or exceeds `REMINDER_OFFSET_MAX`.
 */
export function parseReminderOffset(token: string): number | null {
  const m = TOKEN.exec(token.trim());
  if (m === null) return null;
  if (m[1] === undefined) return 0;
  const minutes = Number(m[1]) * UNIT_MINUTES[(m[2] as string).toLowerCase() as 'm' | 'h' | 'd'];
  return minutes <= REMINDER_OFFSET_MAX ? minutes : null;
}

/** The token for an offset, preferring the largest whole unit (`90` → `90m`, `120` → `2h`). */
export function formatReminderOffset(offsetMinutes: number): string {
  if (offsetMinutes === 0) return 'due';
  if (offsetMinutes % 1440 === 0) return `${offsetMinutes / 1440}d`;
  if (offsetMinutes % 60 === 0) return `${offsetMinutes / 60}h`;
  return `${offsetMinutes}m`;
}
