import { diffDays, type IsoDate } from '@rooster/core/dates';
import { firstOccurrence } from '@rooster/core/recurrence';
import { Bell, CalendarRange, Plus, Repeat, X } from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { PopoverProps as AriaPopoverProps } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import type { Platform } from '../../lib/platform';
import { Button, iconStrokeWidth } from '../../ui/button';
import { IconButton } from '../../ui/icon-button';
import { Input } from '../../ui/input';
import { Kbd } from '../../ui/kbd';
import { Popover } from '../../ui/popover';
import { CalendarGrid, type PickMethod, type CalendarRange as Range } from './calendar-grid';
import { toDueValue, toLocalDue, useDateText } from './date-text';
import { type ParsedDate, type ParsedRange, parsePickerInput, parseRangeInput } from './parser';
import {
  type QuickDateId,
  quickDateForEvent,
  quickDates,
  quickDateValue,
  reminderChord,
} from './quick-dates';
import { type RepeatChoice, RepeatSection, repeatChoiceOf, repeatFields } from './repeat-section';
import { parseTimeInput, TimeField } from './time-field';
import { type DueValue, sameDue, type ViewerDateContext } from './types';

/** 03 §3.4: the popover is 320 px wide with 12 px padding; tall sections scroll inside it. */
export const datePopoverClass = 'w-date-popover overflow-y-auto p-3';

/** A section of the picker below the calendar (P10). */
export type DateSection = 'repeat' | 'reminder';

/** What the reminder slot gets from the picker (P10, 02 §7 item 5). */
export interface ReminderSlotProps {
  /** The due the reminders resolve against: the draft, or the task's value. */
  due: DueValue;
  /** Focus the section's first control (Alt+R, "Add reminder"). */
  autoFocus: boolean;
  /**
   * Saves the date draft now, without closing, so that a relative reminder added next
   * resolves against it (a reminder is its own op, sent at once).
   */
  applyDraft: () => void;
}

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
  /** Kitchen sink: open in range mode even without a start date. */
  defaultRangeMode?: boolean | undefined;
  /** Kitchen sink: force the key-hint platform. */
  platform?: Platform | undefined;
  /** P10: offer "↻ Repeat" (single tasks; not the bulk bar). */
  repeatable?: boolean | undefined;
  /**
   * P10: the "🔔 Reminder" section's content (the task's reminders and presets). Without it
   * the picker offers no reminders (the bulk bar, the kitchen sink's plain picker).
   */
  renderReminders?: ((slot: ReminderSlotProps) => ReactNode) | undefined;
  /** P10: open with this section shown and focused ("Repeat" row, "Add reminder"). */
  initialSection?: DateSection | undefined;
  /** P10: show the reminder section from the start (the task has reminders). */
  showReminders?: boolean | undefined;
  /** P10: saves a value without closing (see `ReminderSlotProps.applyDraft`). */
  onApply?: ((next: DueValue | null) => void) | undefined;
}

type RangeStep = 'start' | 'due';

/** What the text input holds: one date, or a start–due range. */
type Parsed = ({ kind: 'date' } & ParsedDate) | ({ kind: 'range' } & ParsedRange);

/**
 * The picker body (02 §7) without the overlay: text input with live preview, quick
 * chips with Alt chords, month calendar, and the "+ Time" / "+ Start date" footer.
 * `DatePopover` anchors it; the kitchen sink renders it statically.
 *
 * Range mode ("+ Start date", FR-DATE-2): the calendar picks two days, the start and
 * then the due date (reversed picks are swapped), shown with the days between tinted;
 * the second pick commits and closes. The input also takes a range ("oct 10 - 12",
 * "10–12 okt"). Removing the start date returns to a single date.
 */
export function DatePanel({
  value,
  ctx,
  onCommit,
  onCancel,
  onDraftChange,
  autoFocus = true,
  defaultText = '',
  defaultRangeMode,
  platform,
  repeatable = false,
  renderReminders,
  initialSection,
  showReminders = false,
  onApply,
}: DatePanelProps) {
  const { t } = useTranslation('dates', { lng: ctx.locale });
  const text = useDateText(ctx);
  // The value this picker session started from (the caller may re-render underneath).
  const [initial] = useState(() => toLocalDue(value, ctx.timezone));
  const [initialStart] = useState(() =>
    initial && value.startDate && diffDays(value.startDate, initial.date) < 0
      ? value.startDate
      : null,
  );
  const [input, setInput] = useState(defaultText);
  const [draftDate, setDraftDate] = useState<IsoDate | null>(initial?.date ?? null);
  const [draftStart, setDraftStart] = useState<IsoDate | null>(initialStart);
  const [timeMode, setTimeMode] = useState(Boolean(initial?.time));
  const [timeText, setTimeText] = useState(initial?.time ?? '');
  const [timeAutoFocus, setTimeAutoFocus] = useState(false);
  const [rangeMode, setRangeMode] = useState(defaultRangeMode ?? Boolean(initialStart));
  /** Range mode: which end the next pick sets (02 §7, FR-DATE-2). */
  const [rangeStep, setRangeStep] = useState<RangeStep>('start');
  const [previewDate, setPreviewDate] = useState<IsoDate | null>(null);
  const [focusedDate, setFocusedDate] = useState<IsoDate>(
    initialStart ?? initial?.date ?? ctx.today,
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const focusGridRef = useRef(false);
  // P10: the repeat draft. A preset follows the date; the stored rule is derived on commit.
  const [initialRepeat] = useState(() =>
    repeatable
      ? repeatChoiceOf(value.recurrence, value.recurrenceBasis, initial?.date ?? null)
      : null,
  );
  const [repeat, setRepeat] = useState<RepeatChoice | null>(initialRepeat);
  const [repeatOpen, setRepeatOpen] = useState(
    repeatable && (initialRepeat !== null || initialSection === 'repeat'),
  );
  const [reminderOpen, setReminderOpen] = useState(
    Boolean(renderReminders) && (showReminders || initialSection === 'reminder'),
  );
  /** The section the user just opened, which takes focus. */
  const [focusSection, setFocusSection] = useState<DateSection | null>(initialSection ?? null);

  const parseCtx = useMemo(
    () => ({
      today: ctx.today,
      locale: ctx.locale,
      weekStart: ctx.weekStart,
      dateFormat: ctx.dateFormat,
    }),
    [ctx.today, ctx.locale, ctx.weekStart, ctx.dateFormat],
  );
  /** undefined: nothing typed; null: not a date; otherwise a date or a range. */
  const parsed = useMemo((): Parsed | null | undefined => {
    if (!input.trim()) return undefined;
    const range = parseRangeInput(input, parseCtx);
    if (range) return { kind: 'range', ...range };
    const single = parsePickerInput(input, parseCtx);
    return single ? { kind: 'date', ...single } : null;
  }, [input, parseCtx]);
  const draftTime = timeMode ? parseTimeInput(timeText) : null;
  const timeInvalid = timeMode && timeText.trim() !== '' && draftTime === null;

  // Show the month of what is being typed.
  const parsedFocus = parsed ? (parsed.kind === 'range' ? parsed.start : parsed.date) : undefined;
  useEffect(() => {
    if (parsedFocus) setFocusedDate(parsedFocus);
  }, [parsedFocus]);

  // "+ Start date" moves focus to the calendar, where the start is picked.
  useEffect(() => {
    if (!rangeMode || !focusGridRef.current) return;
    focusGridRef.current = false;
    panelRef.current?.querySelector<HTMLElement>('[role="grid"] [tabindex="0"]')?.focus();
  }, [rangeMode]);

  /**
   * The value with the repeat draft applied (P10): the stored rule for the value's date, or
   * `recurrence: null` when a repeat was removed. Without a repeat either way the fields are
   * left out, so the series is untouched.
   */
  const withRepeat = (next: DueValue | null): DueValue | null => {
    if (next === null || !next.dueDate || !repeatable) return next;
    const fields = repeat ? repeatFields(repeat, next.dueDate) : null;
    if (fields) return { ...next, ...fields };
    return value.recurrence ? { ...next, recurrence: null, recurrenceBasis: null } : next;
  };

  const draft = useMemo((): DueValue | null | undefined => {
    const date = draftDate ?? (draftTime ? ctx.today : null);
    // A start waiting for its due date only counts when the due date already fits.
    const start = rangeMode ? draftStart : null;
    const repeatOf = (d: IsoDate | null) => (repeat && d ? repeatFields(repeat, d) : null);
    const sameRepeat =
      !repeatable ||
      ((repeatOf(date)?.recurrence ?? null) === (value.recurrence ?? null) &&
        (repeatOf(date)?.recurrenceBasis ?? null) ===
          (value.recurrence ? (value.recurrenceBasis ?? 'due') : null));
    const unchanged =
      date === (initial?.date ?? null) &&
      draftTime === (initial?.time ?? null) &&
      (date && start && diffDays(start, date) < 0 ? start : null) === initialStart &&
      sameRepeat;
    if (unchanged) return undefined;
    return date ? withRepeat(toDueValue({ date, time: draftTime }, ctx.timezone, start)) : null;
  }, [
    draftDate,
    draftTime,
    draftStart,
    rangeMode,
    initial,
    initialStart,
    ctx.today,
    ctx.timezone,
    repeat,
    value.recurrence,
    value.recurrenceBasis,
    repeatable,
  ]);

  useEffect(() => {
    onDraftChange?.(draft);
  }, [draft, onDraftChange]);

  const commitDraft = () => onCommit(draft === undefined ? value : draft);

  /** Whether a sub-mode keeps the picker open after a pick (02 §7). */
  const staysOpen = timeMode;

  /** Sets a date: commits and closes, unless a sub-mode keeps the picker open. */
  const pick = (date: IsoDate, options: { time?: string | null; commit?: boolean } = {}) => {
    if (rangeMode) {
      pickRangeEnd(date, options);
      return;
    }
    if (staysOpen && !options.commit) {
      setDraftDate(date);
      setFocusedDate(date);
      if (options.time) setTimeText(options.time);
      return;
    }
    const time = options.time ?? draftTime;
    onCommit(withRepeat(toDueValue({ date, time }, ctx.timezone)));
  };

  /** Range mode: the first pick sets the start, the second the due date (then commits). */
  const pickRangeEnd = (date: IsoDate, options: { time?: string | null; commit?: boolean }) => {
    setFocusedDate(date);
    if (rangeStep === 'start') {
      setDraftStart(date);
      setRangeStep('due');
      setPreviewDate(null);
      return;
    }
    const [start, due] =
      draftStart && diffDays(draftStart, date) > 0 ? [date, draftStart] : [draftStart, date];
    setRangeStep('start');
    if (staysOpen && !options.commit) {
      setDraftStart(start);
      setDraftDate(due);
      if (options.time) setTimeText(options.time);
      return;
    }
    const time = options.time ?? draftTime;
    onCommit(withRepeat(toDueValue({ date: due, time }, ctx.timezone, start)));
  };

  const pickQuick = (id: QuickDateId) => {
    const date = quickDateValue(id, ctx.today, ctx.weekStart);
    // "No date" clears the due date and with it the start date.
    if (date === null) onCommit(null);
    else pick(date);
  };

  const onPickDay = (date: IsoDate, method: PickMethod) =>
    pick(date, { commit: method === 'enter' && !rangeMode });

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (parsed === undefined) commitDraft();
    else if (parsed?.kind === 'range') {
      const time = parsed.time ?? draftTime;
      onCommit(withRepeat(toDueValue({ date: parsed.date, time }, ctx.timezone, parsed.start)));
    } else if (parsed) {
      // A single date keeps a start date that still comes before it.
      const time = parsed.time ?? draftTime;
      onCommit(
        withRepeat(
          toDueValue({ date: parsed.date, time }, ctx.timezone, rangeMode ? draftStart : null),
        ),
      );
    }
  };

  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (renderReminders && reminderChord(event)) {
      // Alt+R (02 §7): opens the reminder section, or closes it again.
      event.preventDefault();
      event.stopPropagation();
      toggleReminders();
      return;
    }
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

  const startRangeMode = () => {
    focusGridRef.current = true;
    setRangeMode(true);
    setRangeStep('start');
    setDraftStart(null);
  };

  /** A repeat change (P10). Without a date the series starts on its first occurrence. */
  const changeRepeat = (next: RepeatChoice | null) => {
    setRepeat(next);
    if (!next) {
      setRepeatOpen(false);
      return;
    }
    if (draftDate === null) {
      const today = repeatFields(next, ctx.today);
      const first = today
        ? firstOccurrence(today.recurrence, today.recurrenceBasis, ctx.today)
        : null;
      if (first) {
        setDraftDate(first);
        setFocusedDate(first);
      }
    }
  };

  const openRepeat = () => {
    setRepeatOpen(true);
    setFocusSection('repeat');
  };

  const toggleReminders = () => {
    setReminderOpen((open) => !open);
    setFocusSection('reminder');
  };

  const applyDraft = () => {
    if (draft !== undefined) onApply?.(draft);
  };

  const removeStart = () => {
    setRangeMode(false);
    setRangeStep('start');
    setDraftStart(null);
    setPreviewDate(null);
  };

  const selected = timeMode ? draftDate : (initial?.date ?? null);
  const range: Range | undefined = !rangeMode
    ? undefined
    : parsed?.kind === 'range'
      ? { start: parsed.start, end: parsed.date }
      : rangeStep === 'due'
        ? { start: draftStart, end: previewDate }
        : // Before a start is picked, the current due date shows as a single day.
          { start: draftStart ?? draftDate, end: draftStart ? draftDate : null };

  const status =
    parsed === null
      ? t('popover.invalid')
      : parsed?.kind === 'range'
        ? t('popover.preview', {
            date: text.range(text.short(parsed.start), text.short(parsed.date, parsed.time)),
          })
        : parsed
          ? t('popover.preview', { date: text.short(parsed.date, parsed.time) })
          : !rangeMode
            ? ''
            : rangeStep === 'due'
              ? t('startDate.pickDue')
              : draftStart && draftDate
                ? text.range(text.short(draftStart), text.short(draftDate, draftTime))
                : t('startDate.pickStart');

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: keyboard routing for the whole picker
    <div
      ref={panelRef}
      className="flex flex-col gap-3"
      onKeyDown={onKeyDown}
      onKeyDownCapture={onKeyDownCapture}
    >
      <div className="flex flex-col gap-1">
        <Input
          aria-label={t('popover.inputLabel')}
          placeholder={t(rangeMode ? 'popover.rangePlaceholder' : 'popover.placeholder')}
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
          data-testid="date-picker-status"
          className={cn(
            'min-h-5 px-0.5 text-sm tabular-nums',
            parsed === null ? 'text-text-muted' : 'text-text-secondary',
          )}
        >
          {status}
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
        range={range}
        onPreviewDateChange={rangeMode && rangeStep === 'due' ? setPreviewDate : undefined}
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
        {rangeMode ? (
          <div className="ms-auto flex items-center gap-0.5">
            <CalendarRange
              className="size-4 shrink-0 text-text-muted"
              strokeWidth={iconStrokeWidth}
              aria-hidden
            />
            <span className="ps-1 text-sm text-text-secondary">{t('startDate.label')}</span>
            <IconButton
              size="sm"
              icon={X}
              aria-label={t('startDate.remove')}
              onPress={removeStart}
            />
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            icon={Plus}
            className="ms-auto"
            onPress={startRangeMode}
          >
            {t('startDate.add')}
          </Button>
        )}
      </div>
      {(repeatable && !repeatOpen) || (renderReminders && !reminderOpen) ? (
        <div className="-mt-1 flex items-center gap-2">
          {repeatable && !repeatOpen && (
            <Button variant="ghost" size="sm" icon={Repeat} onPress={openRepeat}>
              {t('repeat.add')}
            </Button>
          )}
          {renderReminders && !reminderOpen && (
            <Button
              variant="ghost"
              size="sm"
              icon={Bell}
              onPress={toggleReminders}
              className="ms-auto"
              aria-keyshortcuts="Alt+R"
            >
              {t('reminder.toggle')}
              <Kbd shortcut="Alt+R" {...(platform ? { platform } : {})} />
            </Button>
          )}
        </div>
      ) : null}
      {repeatOpen && (
        <div className="border-t border-border pt-3">
          <RepeatSection
            choice={repeat}
            dueDate={draftDate ?? initial?.date ?? ctx.today}
            ctx={ctx}
            onChange={changeRepeat}
            autoFocus={focusSection === 'repeat'}
          />
        </div>
      )}
      {renderReminders && reminderOpen && (
        <div className="border-t border-border pt-3">
          {renderReminders({
            due:
              draft === undefined ? value : (draft ?? { ...value, dueDate: null, dueTime: null }),
            autoFocus: focusSection === 'reminder',
            applyDraft,
          })}
        </div>
      )}
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
  /** P10: see `DatePanelProps`. */
  repeatable?: boolean | undefined;
  renderReminders?: DatePanelProps['renderReminders'];
  initialSection?: DateSection | undefined;
  showReminders?: boolean | undefined;
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
  repeatable,
  renderReminders,
  initialSection,
  showReminders,
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
        repeatable={repeatable}
        renderReminders={renderReminders}
        initialSection={initialSection}
        showReminders={showReminders}
        onApply={(next) => {
          if (!sameDue(next, value)) onChange(next);
        }}
      />
    </Popover>
  );
}
