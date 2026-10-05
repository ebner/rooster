import type { IsoDate } from '@rooster/core/dates';
import { Plus } from 'lucide-react';
import { type KeyboardEvent, type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import type { PopoverProps as AriaPopoverProps } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import type { Platform } from '../../lib/platform';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Kbd } from '../../ui/kbd';
import { Popover } from '../../ui/popover';
import { CalendarGrid, type PickMethod } from './calendar-grid';
import { toDueValue, toLocalDue, useDateText } from './date-text';
import { parsePickerInput } from './parser';
import { type QuickDateId, quickDateForEvent, quickDates, quickDateValue } from './quick-dates';
import { parseTimeInput, TimeField } from './time-field';
import { type DueValue, sameDue, type ViewerDateContext } from './types';

/** 03 §3.4: the popover is 320 px wide with 12 px padding. */
export const datePopoverClass = 'w-date-popover p-3';

export interface DatePanelProps {
  /** The due value when the picker opened. */
  value: DueValue;
  ctx: ViewerDateContext;
  /** Commit and close: a new value, or null for "No date". */
  onCommit: (next: DueValue | null) => void;
  /** Esc: close without changes. */
  onCancel: () => void;
  /**
   * Reports the uncommitted draft while the Time sub-mode is in use, so a click
   * outside can commit it (02 §7). `undefined` means nothing is pending.
   */
  onDraftChange?: ((draft: DueValue | null | undefined) => void) | undefined;
  /** Focus the text input on mount (default true). */
  autoFocus?: boolean | undefined;
  /** Kitchen sink and tests: preset typed text. */
  defaultText?: string | undefined;
  /** Kitchen sink: force the key-hint platform. */
  platform?: Platform | undefined;
}

/**
 * The picker body (02 §7) without the overlay: text input with live preview, quick
 * chips with Alt chords, month calendar, and the "+ Time" / "+ Start date" footer.
 * `DatePopover` anchors it; the kitchen sink renders it statically.
 */
export function DatePanel({
  value,
  ctx,
  onCommit,
  onCancel,
  onDraftChange,
  autoFocus = true,
  defaultText = '',
  platform,
}: DatePanelProps) {
  const { t } = useTranslation('dates', { lng: ctx.locale });
  const text = useDateText(ctx);
  // The value this picker session started from (the caller may re-render underneath).
  const [initial] = useState(() => toLocalDue(value, ctx.timezone));
  const [input, setInput] = useState(defaultText);
  const [draftDate, setDraftDate] = useState<IsoDate | null>(initial?.date ?? null);
  const [timeMode, setTimeMode] = useState(Boolean(initial?.time));
  const [timeText, setTimeText] = useState(initial?.time ?? '');
  const [timeAutoFocus, setTimeAutoFocus] = useState(false);
  const [focusedDate, setFocusedDate] = useState<IsoDate>(initial?.date ?? ctx.today);

  const parseCtx = useMemo(
    () => ({
      today: ctx.today,
      locale: ctx.locale,
      weekStart: ctx.weekStart,
      dateFormat: ctx.dateFormat,
    }),
    [ctx.today, ctx.locale, ctx.weekStart, ctx.dateFormat],
  );
  const parsed = useMemo(
    () => (input.trim() ? parsePickerInput(input, parseCtx) : undefined),
    [input, parseCtx],
  );
  const draftTime = timeMode ? parseTimeInput(timeText) : null;
  const timeInvalid = timeMode && timeText.trim() !== '' && draftTime === null;

  // Show the month of what is being typed.
  const parsedDate = parsed?.date;
  useEffect(() => {
    if (parsedDate) setFocusedDate(parsedDate);
  }, [parsedDate]);

  const draft = useMemo((): DueValue | null | undefined => {
    const date = draftDate ?? (draftTime ? ctx.today : null);
    const unchanged = date === (initial?.date ?? null) && draftTime === (initial?.time ?? null);
    if (unchanged) return undefined;
    return date ? toDueValue({ date, time: draftTime }, ctx.timezone) : null;
  }, [draftDate, draftTime, initial, ctx.today, ctx.timezone]);

  useEffect(() => {
    onDraftChange?.(draft);
  }, [draft, onDraftChange]);

  const commitDraft = () => onCommit(draft === undefined ? value : draft);

  /** Sets a date: commits and closes, unless the Time sub-mode keeps the picker open. */
  const pick = (date: IsoDate, options: { time?: string | null; commit?: boolean } = {}) => {
    if (timeMode && !options.commit) {
      setDraftDate(date);
      setFocusedDate(date);
      if (options.time) setTimeText(options.time);
      return;
    }
    const time = options.time ?? draftTime;
    onCommit(toDueValue({ date, time }, ctx.timezone));
  };

  const pickQuick = (id: QuickDateId) => {
    const date = quickDateValue(id, ctx.today, ctx.weekStart);
    if (date === null) onCommit(null);
    else pick(date);
  };

  const onPickDay = (date: IsoDate, method: PickMethod) =>
    pick(date, { commit: method === 'enter' });

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (parsed === undefined) commitDraft();
    else if (parsed) pick(parsed.date, { time: parsed.time, commit: true });
  };

  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    const quick = quickDateForEvent(event);
    if (!quick) return;
    event.preventDefault();
    event.stopPropagation();
    pickQuick(quick.id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    // A combobox closing its suggestion list keeps the picker open.
    if ((event.target as HTMLElement).getAttribute('aria-expanded') === 'true') return;
    onCancel();
  };

  const selected = timeMode ? draftDate : (initial?.date ?? null);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: keyboard routing for the whole picker
    <div className="flex flex-col gap-3" onKeyDown={onKeyDown} onKeyDownCapture={onKeyDownCapture}>
      <div className="flex flex-col gap-1">
        <Input
          aria-label={t('popover.inputLabel')}
          placeholder={t('popover.placeholder')}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onInputKeyDown}
          autoFocus={autoFocus}
          aria-invalid={parsed === null || undefined}
          autoComplete="off"
          spellCheck={false}
        />
        <p
          aria-live="polite"
          className={cn(
            'min-h-5 px-0.5 text-sm tabular-nums',
            parsed === null ? 'text-text-muted' : 'text-text-secondary',
          )}
        >
          {parsed === null
            ? t('popover.invalid')
            : parsed
              ? t('popover.preview', { date: text.short(parsed.date, parsed.time) })
              : ''}
        </p>
      </div>
      <fieldset className="grid grid-cols-2 gap-1.5">
        <legend className="sr-only">{t('popover.quick')}</legend>
        {quickDates.map((quick) => (
          <Button
            key={quick.id}
            variant="secondary"
            size="sm"
            onPress={() => pickQuick(quick.id)}
            className="[&>span]:w-full [&>span]:justify-between"
          >
            {t(`chip.${quick.id}`)}
            <Kbd shortcut={quick.shortcut} {...(platform ? { platform } : {})} />
          </Button>
        ))}
      </fieldset>
      <CalendarGrid
        ctx={ctx}
        selected={selected}
        focusedDate={focusedDate}
        onFocusedDateChange={setFocusedDate}
        onPick={onPickDay}
      />
      <div className="flex min-h-control items-center gap-2 border-t border-border pt-3">
        {timeMode ? (
          <TimeField
            ctx={ctx}
            value={timeText}
            onChange={setTimeText}
            onSubmit={commitDraft}
            onRemove={() => {
              setTimeMode(false);
              setTimeText('');
            }}
            isInvalid={timeInvalid}
            autoFocus={timeAutoFocus}
          />
        ) : (
          <Button
            variant="ghost"
            size="sm"
            icon={Plus}
            onPress={() => {
              setTimeMode(true);
              setTimeAutoFocus(true);
            }}
          >
            {t('time.add')}
          </Button>
        )}
        <Button variant="ghost" size="sm" icon={Plus} isDisabled className="ms-auto">
          {t('startDate.add')}
        </Button>
      </div>
    </div>
  );
}

export interface DatePopoverProps {
  /** The element the popover is anchored to (usually the `DateCell`). */
  triggerRef: RefObject<Element | null>;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  value: DueValue;
  /**
   * Called once per commit with the new value (null clears). Not called on Esc or
   * when the pick equals the current value. New times carry `dueTz = ctx.timezone`.
   */
  onChange: (next: DueValue | null) => void;
  ctx: ViewerDateContext;
  /** Defaults to below the anchor, right-aligned (the date column is on the right). */
  placement?: AriaPopoverProps['placement'] | undefined;
}

/**
 * The anchored date picker (02 §7, 03 §3.4). Picking a day or chip, or Enter on a
 * valid phrase, commits and closes. With the Time sub-mode active, the picker stays
 * open and a click outside (or Enter) commits the draft. Esc never commits.
 */
export function DatePopover({
  triggerRef,
  isOpen,
  onOpenChange,
  value,
  onChange,
  ctx,
  placement = 'bottom end',
}: DatePopoverProps) {
  const { t } = useTranslation('dates', { lng: ctx.locale });
  const pending = useRef<DueValue | null | undefined>(undefined);

  const finish = (next: DueValue | null | undefined) => {
    pending.current = undefined;
    if (next !== undefined && !sameDue(next, value)) onChange(next);
    onOpenChange(false);
  };

  return (
    <Popover
      triggerRef={triggerRef}
      isOpen={isOpen}
      onOpenChange={(open) => (open ? onOpenChange(true) : finish(pending.current))}
      placement={placement}
      className={datePopoverClass}
      aria-label={t('popover.title')}
    >
      <DatePanel
        value={value}
        ctx={ctx}
        onCommit={finish}
        onCancel={() => finish(undefined)}
        onDraftChange={(draft) => {
          pending.current = draft;
        }}
      />
    </Popover>
  );
}
