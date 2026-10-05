import { dueInstant, type IsoDate } from '@rooster/core/dates';
import type { Locale } from '@rooster/i18n';
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
