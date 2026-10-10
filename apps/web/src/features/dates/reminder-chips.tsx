import type { Reminder } from '@rooster/core/schemas';
import { Bell, X } from 'lucide-react';
import { useMemo } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { iconStrokeWidth } from '../../ui/button';
import { formatInstant } from './date-text';
import type { DueValue, ViewerDateContext } from './types';

/** A reminder as the UI lists it: what it is relative to, when it goes off, and its state. */
export interface ReminderView {
  reminder: Reminder;
  /** "1 h before", "At due time", "On the day", or null for an absolute reminder. */
  offset: string | null;
  /** "Fri 13:00"; null while dormant (FR-REM-2: the task has no due date). */
  when: string | null;
  fired: boolean;
}

export type Translate = (key: string, options?: Record<string, unknown>) => string;

/** "15 min before", "1 h before", "2 days before"; 0 is the due moment itself. */
export function offsetText(t: Translate, offsetMinutes: number, allDay: boolean): string {
  if (offsetMinutes === 0) return t(allDay ? 'reminder.onTheDay' : 'reminder.atDue');
  if (offsetMinutes % 1440 === 0) return t('reminder.daysBefore', { count: offsetMinutes / 1440 });
  if (offsetMinutes % 60 === 0) return t('reminder.hoursBefore', { count: offsetMinutes / 60 });
  return t('reminder.minutesBefore', { count: offsetMinutes });
}

/** The reminders in firing order, labelled for chips and the pane line. */
export function useReminderViews(
  items: readonly Reminder[] | undefined,
  due: Pick<DueValue, 'dueDate' | 'dueTime'>,
  ctx: ViewerDateContext,
): ReminderView[] {
  const { t } = useTranslation('dates', { lng: ctx.locale });
  return useMemo(() => {
    const allDay = !due.dueTime;
    return [...(items ?? [])]
      .sort((a, b) => (a.fireAt ?? Number.MAX_SAFE_INTEGER) - (b.fireAt ?? Number.MAX_SAFE_INTEGER))
      .map((reminder) => ({
        reminder,
        offset:
          reminder.kind === 'relative' && reminder.offsetMinutes !== null
            ? offsetText(t as Translate, reminder.offsetMinutes, allDay)
            : null,
        when: reminder.fireAt === null ? null : formatInstant(reminder.fireAt, ctx),
        fired: reminder.firedAt !== null,
      }));
  }, [items, due.dueTime, ctx, t]);
}

/** "1 h before · Fri 13:00", "1 h before · needs a due date", "Fri 13:00". */
export function reminderChipText(t: Translate, view: ReminderView): string {
  const when = view.when ?? t('reminder.dormant');
  return view.offset ? t('reminder.chip', { offset: view.offset, when }) : when;
}

export interface ReminderChipsProps {
  views: readonly ReminderView[];
  ctx: ViewerDateContext;
  onRemove: (reminder: Reminder) => void;
  className?: string | undefined;
  /** Kitchen sink: render a state on the first chip ("hover", "focus"). */
  'data-force'?: string | undefined;
}

/**
 * The user's reminders as removable chips (02 §7, FR-REM). Dormant ones (no due date) and
 * fired ones are muted; every chip keeps its remove button.
 */
export function ReminderChips({
  views,
  ctx,
  onRemove,
  className,
  'data-force': force,
}: ReminderChipsProps) {
  const { t } = useTranslation('dates', { lng: ctx.locale });
  if (views.length === 0) return null;
  return (
    <ul className={cn('flex flex-wrap gap-1.5', className)} data-testid="reminder-chips">
      {views.map((view, i) => {
        const text = reminderChipText(t as Translate, view);
        const muted = view.when === null || view.fired;
        return (
          <li
            key={view.reminder.id}
            data-testid="reminder-chip"
            data-dormant={view.when === null || undefined}
            data-fired={view.fired || undefined}
            className={cn(
              'inline-flex h-chip max-w-full items-center gap-1 rounded-xs bg-bg-muted ps-1.5 text-xs font-medium',
              muted ? 'text-text-muted' : 'text-text-secondary',
            )}
          >
            <Bell className="size-3 shrink-0" strokeWidth={iconStrokeWidth} aria-hidden />
            <span className="truncate">{text}</span>
            {view.fired && <span className="sr-only">{t('reminder.firedSr')}</span>}
            <AriaButton
              aria-label={t('reminder.remove', { reminder: text })}
              onPress={() => onRemove(view.reminder)}
              {...(i === 0 && force ? { 'data-force': force } : {})}
              // WCAG 2.5.8: a 24 px target around the 16 px visual, overhanging the 20 px chip.
              className={cn(
                'group/remove -my-0.5 -ms-1 inline-flex size-6 shrink-0 cursor-default items-center justify-center rounded-xs outline-none',
                'focus-ring:outline-2 focus-ring:outline-border-focus pointer-coarse:size-hit-touch',
              )}
            >
              <span
                aria-hidden
                className="inline-flex size-4 items-center justify-center rounded-2xs group-hover/remove:bg-bg-app/50"
              >
                <X className="size-3" strokeWidth={iconStrokeWidth} />
              </span>
            </AriaButton>
          </li>
        );
      })}
    </ul>
  );
}
