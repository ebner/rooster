import {
  CalendarDays,
  CalendarOff,
  CalendarPlus,
  type LucideIcon,
  Sofa,
  Sun,
  Sunrise,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BottomSheet, SheetOption } from '../../ui/bottom-sheet';
import { DatePanel } from './date-popover';
import { toDueValue, toLocalDue, useDateText } from './date-text';
import { type QuickDateId, quickDateValue } from './quick-dates';
import type { DueValue, ViewerDateContext } from './types';

/** 02 §13.2: the quick date sheet's options, in this order. */
const options: readonly { id: Exclude<QuickDateId, 'noDate'>; icon: LucideIcon }[] = [
  { id: 'today', icon: Sun },
  { id: 'tomorrow', icon: Sunrise },
  { id: 'weekend', icon: Sofa },
  { id: 'nextWeek', icon: CalendarPlus },
];

export interface QuickDateSheetProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** The current due value (the first task's, or the common one). */
  value: DueValue;
  ctx: ViewerDateContext;
  /** A new due value, or null for "No date". The sheet closes itself. */
  onCommit: (next: DueValue | null) => void;
  /** What the date applies to, e.g. the task title or "3 tasks". */
  subject?: ReactNode;
  /** Kitchen sink: in the page flow. */
  isStatic?: boolean;
  /** Kitchen sink: open on the calendar. */
  defaultPicking?: boolean;
}

/**
 * The phone's date picker (02 §13.2): Today, Tomorrow, Weekend, Next week, Pick date… and
 * No date as 48 px rows, each showing the date it sets. "Pick date…" swaps in the full
 * picker (calendar, time, start date) without opening the keyboard.
 */
export function QuickDateSheet({
  isOpen,
  onOpenChange,
  value,
  ctx,
  onCommit,
  subject,
  isStatic = false,
  defaultPicking = false,
}: QuickDateSheetProps) {
  const { t } = useTranslation('dates', { lng: ctx.locale });
  const { t: tm } = useTranslation('mobile');
  const text = useDateText(ctx);
  const [picking, setPicking] = useState(defaultPicking);
  useEffect(() => {
    if (!isOpen) setPicking(defaultPicking);
  }, [isOpen, defaultPicking]);

  const commit = (next: DueValue | null) => {
    onCommit(next);
    onOpenChange(false);
  };
  // A quick date keeps the time of day already set (the same as the desktop chips).
  const time = toLocalDue(value, ctx.timezone)?.time ?? null;

  return (
    <BottomSheet
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={t('popover.title')}
      description={subject}
      isStatic={isStatic}
    >
      {picking ? (
        <div className="px-2 pb-2" data-testid="date-sheet-picker">
          <DatePanel
            value={value}
            ctx={ctx}
            autoFocus={false}
            onCommit={commit}
            onCancel={() => setPicking(false)}
          />
        </div>
      ) : (
        <div className="flex flex-col" data-testid="quick-date-sheet">
          {options.map(({ id, icon }) => {
            const date = quickDateValue(id, ctx.today, ctx.weekStart);
            return (
              <SheetOption
                key={id}
                icon={icon}
                label={t(`chip.${id}`)}
                detail={date ? text.short(date) : undefined}
                onPress={() => date && commit(toDueValue({ date, time }, ctx.timezone))}
              />
            );
          })}
          <SheetOption
            icon={CalendarDays}
            label={tm('date.pick')}
            onPress={() => setPicking(true)}
          />
          <SheetOption
            icon={CalendarOff}
            label={t('chip.noDate')}
            isDisabled={!value.dueDate}
            onPress={() => commit(null)}
          />
        </div>
      )}
    </BottomSheet>
  );
}
