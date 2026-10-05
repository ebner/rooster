import {
  addDays,
  type IsoDate,
  nextWeekday,
  startOfWeek,
  type WeekStart,
} from '@rooster/core/dates';

export type QuickDateId = 'today' | 'tomorrow' | 'nextWeek' | 'weekend' | 'noDate';

export interface QuickDate {
  id: QuickDateId;
  /** `KeyboardEvent.code` of the Alt chord (layout-independent, so ⌥ on macOS works). */
  code: string;
  /** The hint shown in a `Kbd` (02 §7: Alt+T, Alt+M, Alt+W, Alt+E, Alt+0). */
  shortcut: string;
}

/** 02 §7 quick chips, in display order. */
export const quickDates: readonly QuickDate[] = [
  { id: 'today', code: 'KeyT', shortcut: 'Alt+T' },
  { id: 'tomorrow', code: 'KeyM', shortcut: 'Alt+M' },
  { id: 'nextWeek', code: 'KeyW', shortcut: 'Alt+W' },
  { id: 'weekend', code: 'KeyE', shortcut: 'Alt+E' },
  { id: 'noDate', code: 'Digit0', shortcut: 'Alt+0' },
];

/**
 * The date a chip sets, matching the parser's meaning of the same words (02 §8.2):
 * "next week" is the next week-start day, "weekend" the coming Saturday (today when
 * today is Saturday). `noDate` clears.
 */
export function quickDateValue(
  id: QuickDateId,
  today: IsoDate,
  weekStart: WeekStart,
): IsoDate | null {
  switch (id) {
    case 'today':
      return today;
    case 'tomorrow':
      return addDays(today, 1);
    case 'nextWeek':
      return addDays(startOfWeek(today, weekStart), 7);
    case 'weekend':
      return nextWeekday(today, 6, { includeToday: true });
    case 'noDate':
      return null;
  }
}

interface ChordEvent {
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/** The chip for an Alt chord, matched by `event.code`; plain letters never match. */
export function quickDateForEvent(event: ChordEvent): QuickDate | undefined {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return undefined;
  return quickDates.find((q) => q.code === event.code);
}
