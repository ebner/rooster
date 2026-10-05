import { type DueState, dueState, formatRelative, type IsoDate } from '@rooster/core/dates';
import { CircleAlert } from 'lucide-react';
import { Focusable } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { Tooltip } from '../../ui/tooltip';
import { toLocalDue, useDateText } from './date-text';
import type { DueValue, ViewerDateContext } from './types';

/** 03 §2.3: colour and weight per due state; coral never appears in date labels. */
export const dueStateClass: Record<DueState, string> = {
  overdue: 'font-medium text-date-overdue',
  today: 'font-medium text-date-today',
  tomorrow: 'text-date-tomorrow',
  thisWeek: 'text-date-this-week',
  later: 'text-date-later',
  done: 'text-date-done',
  none: 'text-text-muted',
};

export interface DateLabelProps {
  /** The task's due fields. Renders nothing without a `dueDate`. */
  value: DueValue;
  /** Viewer settings and clock (`useViewerDateContext()`). */
  ctx: ViewerDateContext;
  /** Completed tasks use the muted `done` style. */
  completed?: boolean | undefined;
  /** P3 start date: renders a range ("Oct 10 – 12"), coloured by the due state. */
  startDate?: IsoDate | null | undefined;
  /**
   * Shows the full date in a tooltip on hover (02 §8.3). Off inside interactive
   * parents such as `DateCell`, which carry their own tooltip.
   */
  tooltip?: boolean | undefined;
  className?: string | undefined;
}

export interface DateLabelInfo {
  state: DueState;
  /** "Fri", "Today 14:00", "Oct 10 – 12". */
  label: string;
  /** "Friday, 10 October 2026, 14:00". */
  full: string;
}

/** The text, full form and state of a due value; null when there is no date. */
export function useDateLabel(
  value: DueValue,
  ctx: ViewerDateContext,
  options: { completed?: boolean | undefined; startDate?: IsoDate | null | undefined } = {},
): DateLabelInfo | null {
  const text = useDateText(ctx);
  const local = toLocalDue(value, ctx.timezone);
  if (!local || !value.dueDate) return null;
  // Judged on the viewer-local date and time (the same instant), so the colour always
  // agrees with the label even when the due was set in another zone.
  const state = dueState(
    {
      dueDate: local.date,
      dueTime: local.time,
      dueTz: ctx.timezone,
      completed: options.completed ?? false,
    },
    { today: ctx.today, nowMs: ctx.nowMs, viewerTz: ctx.timezone },
  );
  const startDate = options.startDate ?? null;
  const label = formatRelative(
    { dueDate: local.date, dueTime: local.time, startDate },
    {
      today: ctx.today,
      locale: ctx.locale,
      dateFormat: ctx.dateFormat,
      timeFormat: ctx.timeFormat,
    },
  );
  const fullDue = text.full(local.date, local.time);
  const full = startDate ? text.range(text.full(startDate), fullDue) : fullDue;
  return { state, label, full };
}

/**
 * The relative due label (02 §8.3) in its 03 §2.3 colour: overdue adds a 12 px
 * `circle-alert` and weight 500. Tabular numerals, `--text-sm`.
 */
export function DateLabel({
  value,
  ctx,
  completed,
  startDate,
  tooltip = true,
  className,
}: DateLabelProps) {
  const info = useDateLabel(value, ctx, { completed, startDate });
  const { t } = useTranslation('dates', { lng: ctx.locale });
  if (!info) return null;
  const content = <DateLabelContent info={info} overdueText={t('cell.overdue')} />;
  const classes = cn(
    'inline-flex items-center gap-1 text-sm whitespace-nowrap tabular-nums',
    dueStateClass[info.state],
    className,
  );
  if (!tooltip) return <span className={classes}>{content}</span>;
  return (
    <Tooltip content={info.full}>
      <Focusable excludeFromTabOrder>
        <span role="img" aria-label={ariaText(info, t('cell.overdue'))} className={classes}>
          {content}
        </span>
      </Focusable>
    </Tooltip>
  );
}

function ariaText(info: DateLabelInfo, overdueText: string): string {
  return info.state === 'overdue' ? `${overdueText}: ${info.label}` : info.label;
}

/** Icon plus label; the overdue icon is named for screen readers. */
export function DateLabelContent({
  info,
  overdueText,
}: {
  info: DateLabelInfo;
  overdueText: string;
}) {
  return (
    <>
      {info.state === 'overdue' && (
        <>
          <CircleAlert className="size-3 shrink-0" strokeWidth={2} aria-hidden />
          <span className="sr-only">{overdueText}: </span>
        </>
      )}
      <span>{info.label}</span>
    </>
  );
}
