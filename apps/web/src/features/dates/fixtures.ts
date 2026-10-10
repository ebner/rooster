import { dueInstant, type IsoDate } from '@rooster/core/dates';
import type { Reminder } from '@rooster/core/schemas';
import type { Locale } from '@rooster/i18n/core';
import type { DueValue, ViewerDateContext } from './types';

export const sampleZone = 'Europe/Stockholm';
/** A fixed Thursday, so samples and tests render the same on every day. */
export const sampleToday = '2026-10-08';

/** Deterministic viewer settings (10:30 on `sampleToday`) for the kitchen sink and tests. */
export function sampleDateContext(
  locale: Locale,
  overrides: Partial<ViewerDateContext> = {},
): ViewerDateContext {
  return {
    today: sampleToday,
    nowMs: dueInstant(sampleToday, '10:30', sampleZone),
    locale,
    weekStart: 1,
    dateFormat: locale === 'sv' ? 'd MMM' : 'MMM d',
    timeFormat: locale === 'sv' ? '24h' : '12h',
    timezone: sampleZone,
    ...overrides,
  };
}

/** A due value in the sample zone, optionally with a start date. */
export function sampleDue(
  dueDate: IsoDate,
  dueTime: string | null = null,
  startDate: IsoDate | null = null,
): DueValue {
  return { dueDate, dueTime, dueTz: dueTime ? sampleZone : null, startDate };
}

/** The sample owner of reminders (FR-REM-2): the sample zone, all-day reminders at 09:00. */
export const sampleOwner = { timezone: sampleZone, allDayReminderTime: '09:00' };

/** A reminder on a task due `due` (P10 kitchen sink and tests). */
export function sampleReminder(
  id: number,
  spec: { offsetMinutes: number } | { at: number },
  due: DueValue | null,
  fired = false,
): Reminder {
  const relative = 'offsetMinutes' in spec;
  const dueAt = due?.dueDate
    ? dueInstant(due.dueDate, due.dueTime ?? sampleOwner.allDayReminderTime, sampleZone)
    : null;
  const fireAt = relative ? (dueAt === null ? null : dueAt - spec.offsetMinutes * 60_000) : spec.at;
  return {
    id: `01900000-0000-7000-8000-0000000003${String(id).padStart(2, '0')}`,
    taskId: '01900000-0000-7000-8000-000000000300',
    kind: relative ? 'relative' : 'absolute',
    offsetMinutes: relative ? spec.offsetMinutes : null,
    remindAt: relative ? null : spec.at,
    fireAt,
    firedAt: fired && fireAt !== null ? fireAt : null,
    createdAt: 0,
  };
}
