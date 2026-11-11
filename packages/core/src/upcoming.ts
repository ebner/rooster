import type { IsoDate } from './dates/index.ts';
import { compareKeys } from './ordering.ts';
import type { Task } from './schemas/index.ts';

/**
 * Upcoming recurring tasks (ADR 0068). An open, top-level recurring task whose day hasn't come
 * yet stays out of its group in My tasks and is listed in the collapsed Upcoming section at the
 * end instead. On its day it is back in its group, where its placement put it: the placement
 * itself never changes. The smart views stay date-based and are not affected.
 *
 * Pure and shared by the web list, the TUI and `rooster ls`.
 */

type UpcomingFields = Pick<
  Task,
  'parentId' | 'recurrence' | 'startDate' | 'dueDate' | 'completedAt'
> & { deletedAt?: number | null | undefined };

/** The day a recurring task returns to its group: its start date, else its due date. */
export function upcomingDay(task: Pick<Task, 'startDate' | 'dueDate'>): IsoDate | null {
  return task.startDate ?? task.dueDate;
}

/**
 * Whether the task belongs in Upcoming on `today` (the viewer's today, in their timezone):
 * open, not deleted, top-level, recurring, and its day (`upcomingDay`) is after today. A
 * completed instance stays where it was, and a recurring subtask stays under its parent.
 */
export function isUpcoming(task: UpcomingFields, today: IsoDate): boolean {
  if (task.completedAt !== null || (task.deletedAt ?? null) !== null) return false;
  if (task.parentId !== null || !task.recurrence) return false;
  const day = upcomingDay(task);
  return day !== null && day > today;
}

/**
 * Upcoming's order: by day, then due date, then due time (untimed last), then title, then ID,
 * so the section reads like a short calendar.
 */
export function compareUpcoming(
  a: Pick<Task, 'id' | 'title' | 'startDate' | 'dueDate' | 'dueTime'>,
  b: Pick<Task, 'id' | 'title' | 'startDate' | 'dueDate' | 'dueTime'>,
): number {
  return (
    compareKeys(upcomingDay(a) ?? '', upcomingDay(b) ?? '') ||
    compareKeys(a.dueDate ?? '', b.dueDate ?? '') ||
    compareTime(a.dueTime, b.dueTime) ||
    compareKeys(a.title, b.title) ||
    compareKeys(a.id, b.id)
  );
}

function compareTime(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return compareKeys(a, b);
}
