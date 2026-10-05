import type { IsoDate } from '@rooster/core/dates';
import { Calendar } from 'lucide-react';
import { type KeyboardEvent, type Ref, useCallback, useRef, useState } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { iconStrokeWidth } from '../../ui/button';
import { Tooltip } from '../../ui/tooltip';
import { DateLabel, DateLabelContent, dueStateClass, useDateLabel } from './date-label';
import { DatePopover } from './date-popover';
import type { DueValue, ViewerDateContext } from './types';

/** The single-key shortcut that opens the picker from a focused cell (02 §6). */
export const dateCellShortcut = 'D';

export interface DateCellProps {
  /** The task's due fields. */
  value: DueValue;
  /**
   * Called with the new value, or null when cleared ("No date", or Delete/Backspace
   * on the focused cell). Recording undo is the caller's job.
   */
  onChange: (next: DueValue | null) => void;
  ctx: ViewerDateContext;
  /** Completed tasks show the muted `done` label. */
  completed?: boolean | undefined;
  /** Overrides `value.startDate` for the range label; normally left out. */
  startDate?: IsoDate | null | undefined;
  /** Shows the label only: no picker, no clearing, no tab stop. */
  isReadOnly?: boolean | undefined;
  /**
   * Controlled picker state, e.g. for the row's D / Tab+D shortcuts. Leave both unset
   * to let the cell manage it (click, Enter, Space or D opens).
   */
  isOpen?: boolean | undefined;
  onOpenChange?: ((isOpen: boolean) => void) | undefined;
  /**
   * Shows the empty-cell calendar icon. Rows can instead add the `group/row` class:
   * the icon then appears on row hover and focus-within without re-rendering.
   */
  rowHovered?: boolean | undefined;
  /** Extra description for screen readers, e.g. the id of the row's title. */
  'aria-describedby'?: string | undefined;
  /** Kitchen sink: render a state statically ("hover", "focus"). */
  'data-force'?: string | undefined;
  className?: string | undefined;
  /** The focusable cell (the picker's anchor), for roving focus in the list. */
  ref?: Ref<HTMLButtonElement> | undefined;
}

/**
 * The 112 px right-aligned due-date column of a task row (02 §7, 03 §3.1). Shows the
 * relative label; empty cells reveal a muted calendar icon on row hover or focus.
 * Focus wins (02 §6): while the cell has focus, Delete/Backspace clear the date and
 * D opens the picker; neither reaches the row.
 */
export function DateCell({
  value,
  onChange,
  ctx,
  completed,
  startDate,
  isReadOnly = false,
  isOpen: isOpenProp,
  onOpenChange,
  rowHovered = false,
  'aria-describedby': describedBy,
  'data-force': force,
  className,
  ref,
}: DateCellProps) {
  const { t } = useTranslation('dates', { lng: ctx.locale });
  const info = useDateLabel(value, ctx, { completed, startDate });
  const [isOpenState, setOpenState] = useState(false);
  const isOpen = isOpenProp ?? isOpenState;
  const setOpen = (open: boolean) => {
    setOpenState(open);
    onOpenChange?.(open);
  };
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const setRefs = useCallback(
    (node: HTMLButtonElement | null) => {
      buttonRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  const cellClass = cn('flex w-date-cell shrink-0 items-center justify-end', className);

  if (isReadOnly) {
    return (
      <div className={cellClass}>
        <DateLabel
          value={value}
          ctx={ctx}
          completed={completed}
          startDate={startDate}
          className="px-2"
        />
      </div>
    );
  }

  const onKeyDown = (event: KeyboardEvent) => {
    const plain = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    if (plain && (event.key === 'Delete' || event.key === 'Backspace')) {
      event.preventDefault();
      if (value.dueDate) onChange(null);
      return;
    }
    if (plain && event.key.toLowerCase() === dateCellShortcut.toLowerCase()) {
      event.preventDefault();
      setOpen(true);
      return;
    }
    // React Aria stops propagation by default; everything else belongs to the row.
    (event as KeyboardEvent & { continuePropagation?: () => void }).continuePropagation?.();
  };

  const label = info ? t('cell.label', { label: info.label, full: info.full }) : t('cell.set');

  return (
    <div className={cellClass}>
      <Tooltip content={info?.full ?? t('cell.set')} shortcut={dateCellShortcut}>
        <AriaButton
          ref={setRefs}
          aria-label={label}
          {...(describedBy ? { 'aria-describedby': describedBy } : {})}
          {...(force ? { 'data-force': force } : {})}
          onPress={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className={cn(
            'group/cell inline-flex h-control-sm max-w-full cursor-default items-center justify-end rounded-sm px-2',
            'text-sm whitespace-nowrap tabular-nums',
            info && 'hover:underline hover:underline-offset-2',
            info ? dueStateClass[info.state] : 'text-text-muted',
          )}
        >
          {info ? (
            <span className="inline-flex items-center gap-1">
              <DateLabelContent info={info} overdueText={t('cell.overdue')} />
            </span>
          ) : (
            <Calendar
              aria-hidden
              strokeWidth={iconStrokeWidth}
              className={cn(
                'size-4 opacity-0 transition-opacity duration-(--dur-fast) ease-standard',
                'group-hover/row:opacity-60 group-focus-within/row:opacity-60',
                'group-hover/cell:opacity-60 group-focus-visible/cell:opacity-60',
                'group-data-[force~=focus]/cell:opacity-60',
                (rowHovered || isOpen) && 'opacity-60',
              )}
            />
          )}
        </AriaButton>
      </Tooltip>
      <DatePopover
        triggerRef={buttonRef}
        isOpen={isOpen}
        onOpenChange={setOpen}
        value={value}
        onChange={onChange}
        ctx={ctx}
      />
    </div>
  );
}
