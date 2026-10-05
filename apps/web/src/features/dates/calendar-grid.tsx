import {
  addDays,
  daysInMonth,
  formatIsoDate,
  type IsoDate,
  parseIsoDate,
  startOfWeek,
  type WeekStart,
  weekdayOf,
} from '@rooster/core/dates';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { IconButton } from '../../ui/icon-button';
import { useDateText } from './date-text';
import type { ViewerDateContext } from './types';

/** Moves a date by whole months, clamping the day (Jan 31 + 1 month → Feb 28). */
export function addMonths(date: IsoDate, months: number): IsoDate {
  const { year, month, day } = parseIsoDate(date);
  const index = year * 12 + (month - 1) + months;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return formatIsoDate({ year: y, month: m, day: Math.min(day, daysInMonth(y, m)) });
}

/**
 * The weeks shown for the month containing `date`: each a row of 7 dates starting on
 * `weekStart`, with null outside the month (those cells stay blank).
 */
export function monthWeeks(date: IsoDate, weekStart: WeekStart): (IsoDate | null)[][] {
  const { year, month } = parseIsoDate(date);
  const first = formatIsoDate({ year, month, day: 1 });
  const last = formatIsoDate({ year, month, day: daysInMonth(year, month) });
  const weeks: (IsoDate | null)[][] = [];
  let cursor = startOfWeek(first, weekStart);
  while (cursor <= last) {
    const week: (IsoDate | null)[] = [];
    for (let i = 0; i < 7; i += 1) {
      const day = addDays(cursor, i);
      week.push(day >= first && day <= last ? day : null);
    }
    weeks.push(week);
    cursor = addDays(cursor, 7);
  }
  return weeks;
}

/** How a day was picked: Enter commits even in the time sub-mode (02 §7). */
export type PickMethod = 'pointer' | 'enter' | 'space';

/** A highlighted start–due range (FR-DATE-2); either end may still be open. */
export interface CalendarRange {
  start: IsoDate | null;
  end: IsoDate | null;
}

export interface CalendarGridProps {
  ctx: ViewerDateContext;
  /** The filled day (the current or draft due date). Ignored when `range` is set. */
  selected: IsoDate | null;
  /** Range mode: both ends filled, the days between tinted (03 §3.4). */
  range?: CalendarRange | undefined;
  /** The day under the pointer or keyboard focus, for previewing a range's open end. */
  onPreviewDateChange?: ((date: IsoDate | null) => void) | undefined;
  /** The roving-focus day; its month is the one shown. */
  focusedDate: IsoDate;
  onFocusedDateChange: (date: IsoDate) => void;
  onPick: (date: IsoDate, method: PickMethod) => void;
}

/**
 * 03 §3.4 month grid: 36 px cells, today ringed, the selection filled with the accent,
 * weekend columns muted. Keyboard per the APG date-picker grid: arrows move by day or
 * week, PageUp/PageDown by month (Shift: year), Home/End to the week's ends, Enter or
 * Space picks.
 */
export function CalendarGrid({
  ctx,
  selected,
  range,
  onPreviewDateChange,
  focusedDate,
  onFocusedDateChange,
  onPick,
}: CalendarGridProps) {
  const { t } = useTranslation('dates', { lng: ctx.locale });
  const text = useDateText(ctx);
  const labelId = useId();
  const gridRef = useRef<HTMLTableElement>(null);
  const moveFocusRef = useRef(false);
  const { year, month } = parseIsoDate(focusedDate);
  const weeks = monthWeeks(focusedDate, ctx.weekStart);
  const columns = weeks[0]?.map((_, i) => (ctx.weekStart + i) % 7) ?? [];

  // Keyboard moves keep DOM focus on the roving cell, even across months.
  useEffect(() => {
    if (!moveFocusRef.current) return;
    moveFocusRef.current = false;
    gridRef.current?.querySelector<HTMLElement>(`[data-date="${focusedDate}"]`)?.focus();
  }, [focusedDate]);

  const onKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    let next: IsoDate | null = null;
    switch (event.key) {
      case 'ArrowLeft':
        next = addDays(focusedDate, -1);
        break;
      case 'ArrowRight':
        next = addDays(focusedDate, 1);
        break;
      case 'ArrowUp':
        next = addDays(focusedDate, -7);
        break;
      case 'ArrowDown':
        next = addDays(focusedDate, 7);
        break;
      case 'PageUp':
        next = addMonths(focusedDate, event.shiftKey ? -12 : -1);
        break;
      case 'PageDown':
        next = addMonths(focusedDate, event.shiftKey ? 12 : 1);
        break;
      case 'Home':
        next = startOfWeek(focusedDate, ctx.weekStart);
        break;
      case 'End':
        next = addDays(startOfWeek(focusedDate, ctx.weekStart), 6);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        event.stopPropagation();
        onPick(focusedDate, event.key === 'Enter' ? 'enter' : 'space');
        return;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    moveFocusRef.current = true;
    onFocusedDateChange(next);
    onPreviewDateChange?.(next);
  };

  const [rangeFrom, rangeTo] =
    range?.start && range.end && range.end < range.start
      ? [range.end, range.start]
      : [range?.start ?? null, range?.end ?? null];
  const dayState = (date: IsoDate): DayState => {
    if (!range) return date === selected ? 'selected' : 'none';
    if (date === rangeFrom || date === rangeTo) return 'selected';
    if (rangeFrom && rangeTo && date > rangeFrom && date < rangeTo) return 'between';
    return 'none';
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between ps-2">
        <h3 id={labelId} aria-live="polite" className="text-sm font-medium text-text">
          {text.monthYear(year, month)}
        </h3>
        <div className="flex items-center">
          <IconButton
            size="sm"
            icon={ChevronLeft}
            aria-label={t('calendar.previousMonth')}
            onPress={() => onFocusedDateChange(addMonths(focusedDate, -1))}
          />
          <IconButton
            size="sm"
            icon={ChevronRight}
            aria-label={t('calendar.nextMonth')}
            onPress={() => onFocusedDateChange(addMonths(focusedDate, 1))}
          />
        </div>
      </div>
      <table
        ref={gridRef}
        // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: APG date-picker grid pattern
        role="grid"
        aria-labelledby={labelId}
        onKeyDown={onKeyDown}
        onClick={(event) => {
          const date = (event.target as HTMLElement).closest<HTMLElement>('[data-date]')?.dataset
            .date;
          if (!date) return;
          onFocusedDateChange(date);
          onPick(date, 'pointer');
        }}
        onPointerOver={(event) => {
          const date = (event.target as HTMLElement).closest<HTMLElement>('[data-date]')?.dataset
            .date;
          if (date) onPreviewDateChange?.(date);
        }}
        onPointerLeave={() => onPreviewDateChange?.(null)}
        className="mx-auto border-separate border-spacing-0"
      >
        <thead>
          <tr>
            {columns.map((weekday) => (
              <th
                key={weekday}
                scope="col"
                abbr={text.weekdayLong(weekday)}
                className="size-calendar-cell p-0 text-center text-xs font-normal text-text-muted"
              >
                {text.weekdayNarrow(weekday)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week.find(Boolean) ?? ''}>
              {week.map((date, i) =>
                date ? (
                  <DayCell
                    key={date}
                    date={date}
                    label={text.full(date)}
                    isToday={date === ctx.today}
                    state={dayState(date)}
                    isFocused={date === focusedDate}
                  />
                ) : (
                  <td key={`blank-${i}`} className="size-calendar-cell p-0" />
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** `selected`: the single day or a range end (accent fill); `between`: inside a range. */
type DayState = 'none' | 'selected' | 'between';

interface DayCellProps {
  date: IsoDate;
  label: string;
  isToday: boolean;
  state: DayState;
  isFocused: boolean;
}

function DayCell({ date, label, isToday, state, isFocused }: DayCellProps) {
  const weekday = weekdayOf(date);
  const isWeekend = weekday === 0 || weekday === 6;
  return (
    <td
      // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: APG date-picker grid pattern
      role="gridcell"
      data-date={date}
      tabIndex={isFocused ? 0 : -1}
      aria-selected={state !== 'none'}
      aria-label={label}
      {...(isToday ? { 'aria-current': 'date' as const } : {})}
      className={cn(
        'size-calendar-cell cursor-default rounded-sm p-0 text-center text-sm tabular-nums',
        'border-(length:--border-check) border-transparent outline-offset-0',
        'transition-colors duration-(--dur-fast) ease-standard',
        isWeekend ? 'text-text-muted' : 'text-text',
        isToday && 'border-border-focus',
        state === 'selected' && 'bg-bg-accent font-medium text-text-on-accent',
        state === 'between' && 'rounded-none bg-bg-selected',
        state === 'none' && 'hover:bg-bg-subtle',
      )}
    >
      {Number(date.slice(8))}
    </td>
  );
}
