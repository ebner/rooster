import { addDays, type IsoDate, parseIsoDate } from '@rooster/core/dates';
import {
  formatRule,
  normalizeRule,
  parseRule,
  presetOf,
  RECURRENCE_FREQS,
  type RecurrenceBasis,
  type RecurrenceFreq,
  type RecurrencePresetId,
  type RecurrenceRule,
  recurrencePresets,
  WEEKDAYS,
  type Weekday,
  weekdayCode,
} from '@rooster/core/recurrence';
import { Repeat, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  Input as AriaInput,
  Group,
  Label,
  NumberField,
  Radio,
  RadioGroup,
  Switch,
  ToggleButton,
} from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { iconStrokeWidth } from '../../ui/button';
import { IconButton } from '../../ui/icon-button';
import { Input } from '../../ui/input';
import { Select } from '../../ui/select';
import { useDateText } from './date-text';
import { parsePickerInput } from './parser';
import { useRuleText } from './recurrence-text';
import type { ViewerDateContext } from './types';

/**
 * What the picker's repeat section holds (FR-REC-1): a preset, which follows the due date
 * ("weekly" on a task moved to Monday repeats on Mondays), or a custom rule.
 */
export type RepeatChoice =
  | { kind: 'preset'; id: RecurrencePresetId }
  | { kind: 'custom'; rule: string; basis: RecurrenceBasis };

/** The stored rule and basis for a choice on a series due on `dueDate` (normalised, ADR 0049). */
export function repeatFields(
  choice: RepeatChoice,
  dueDate: IsoDate,
): { recurrence: string; recurrenceBasis: RecurrenceBasis } | null {
  if (choice.kind === 'preset') {
    const preset = recurrencePresets(dueDate).find((p) => p.id === choice.id);
    return preset ? { recurrence: preset.rule, recurrenceBasis: 'due' } : null;
  }
  const rule = normalizeRule(choice.rule, dueDate, choice.basis);
  return rule ? { recurrence: rule, recurrenceBasis: choice.basis } : null;
}

/** The choice a stored rule reads as: its preset when it is one, otherwise custom. */
export function repeatChoiceOf(
  rule: string | null | undefined,
  basis: RecurrenceBasis | null | undefined,
  dueDate: IsoDate | null,
): RepeatChoice | null {
  if (!rule) return null;
  const preset = basis !== 'completion' && dueDate ? presetOf(rule, dueDate) : null;
  // A preset with an end condition stays custom, so the end is kept.
  const parsed = parseRule(rule);
  if (preset && parsed && parsed.count === undefined && parsed.until === undefined) {
    return { kind: 'preset', id: preset };
  }
  return { kind: 'custom', rule, basis: basis ?? 'due' };
}

type MonthlyMode = 'day' | 'nth' | 'last';
type EndMode = 'never' | 'until' | 'count';

/** The anchor parts of the current rule, kept when an unrelated field changes. */
type RuleAnchor = Pick<RecurrenceRule, 'freq' | 'byDay' | 'byMonthDay' | 'byMonth'>;

/** The custom editor's fields; the rule is rebuilt from them on every change. */
interface CustomFields {
  freq: RecurrenceFreq;
  interval: number;
  weekdays: Weekday[];
  monthly: MonthlyMode;
  end: EndMode;
  until: IsoDate | null;
  count: number;
  basis: RecurrenceBasis;
  /**
   * The current rule's anchor (null for a new rule). A monthly series on the 31st whose
   * occurrence was clamped to Feb 28 stays on the 31st when only its end changes.
   */
  anchor: RuleAnchor | null;
}

/** 1–4 for the 1st–28th; the 29th and later have no "nth" weekday (only "last"). */
const nthOf = (date: IsoDate) => Math.ceil(parseIsoDate(date).day / 7);

function fieldsOf(choice: RepeatChoice | null, dueDate: IsoDate): CustomFields {
  const base: CustomFields = {
    freq: 'WEEKLY',
    interval: 1,
    weekdays: [weekdayCode(dueDate)],
    monthly: 'day',
    end: 'never',
    until: null,
    count: 5,
    basis: 'due',
    anchor: null,
  };
  const fields = choice ? repeatFields(choice, dueDate) : null;
  const rule = fields ? parseRule(fields.recurrence) : null;
  if (!rule || !fields) return base;
  const nth = rule.freq === 'MONTHLY' ? rule.byDay?.[0]?.nth : undefined;
  return {
    ...base,
    freq: rule.freq,
    interval: rule.interval,
    weekdays:
      rule.freq === 'WEEKLY' && rule.byDay ? rule.byDay.map((d) => d.weekday) : base.weekdays,
    monthly: nth === undefined ? 'day' : nth === -1 ? 'last' : 'nth',
    end: rule.count !== undefined ? 'count' : rule.until !== undefined ? 'until' : 'never',
    until: rule.until ?? null,
    count: rule.count ?? base.count,
    basis: fields.recurrenceBasis,
    anchor: {
      freq: rule.freq,
      ...(rule.byDay ? { byDay: rule.byDay } : {}),
      ...(rule.byMonthDay === undefined ? {} : { byMonthDay: rule.byMonthDay }),
      ...(rule.byMonth === undefined ? {} : { byMonth: rule.byMonth }),
    },
  };
}

/**
 * The monthly or yearly anchor for the fields: the current rule's while the frequency (and,
 * for monthly, the day/nth/last mode) is unchanged, otherwise derived from the due date.
 */
function anchorOf(
  fields: CustomFields,
  dueDate: IsoDate,
): { monthDay: number; month: number; nthDay: { weekday: Weekday; nth: number } } {
  const { month, day } = parseIsoDate(dueDate);
  const kept = fields.anchor?.freq === fields.freq ? fields.anchor : null;
  const keptNth = kept?.byDay?.[0];
  const nthMatches =
    keptNth?.nth !== undefined &&
    ((fields.monthly === 'last' && keptNth.nth === -1) ||
      (fields.monthly === 'nth' && keptNth.nth > 0));
  const derivedNth = fields.monthly === 'last' || nthOf(dueDate) > 4 ? -1 : nthOf(dueDate);
  return {
    monthDay: kept?.byMonthDay ?? day,
    month: kept?.byMonth ?? month,
    nthDay:
      nthMatches && keptNth?.nth !== undefined
        ? { weekday: keptNth.weekday, nth: keptNth.nth }
        : { weekday: weekdayCode(dueDate), nth: derivedNth },
  };
}

function ruleOf(fields: CustomFields, dueDate: IsoDate): string {
  const anchor = anchorOf(fields, dueDate);
  const end = {
    ...(fields.end === 'count' ? { count: fields.count } : {}),
    ...(fields.end === 'until' && fields.until ? { until: fields.until } : {}),
  };
  const rule: RecurrenceRule = { freq: fields.freq, interval: fields.interval, ...end };
  if (fields.basis === 'due') {
    if (fields.freq === 'WEEKLY') {
      rule.byDay = (fields.weekdays.length > 0 ? fields.weekdays : [weekdayCode(dueDate)]).map(
        (weekday) => ({ weekday }),
      );
    } else if (fields.freq === 'MONTHLY') {
      if (fields.monthly === 'day') rule.byMonthDay = anchor.monthDay;
      else rule.byDay = [anchor.nthDay];
    } else if (fields.freq === 'YEARLY') {
      rule.byMonth = anchor.month;
      rule.byMonthDay = anchor.monthDay;
    }
  }
  return formatRule(rule);
}

const radioClass = cn(
  'group flex min-h-control-sm cursor-default items-center gap-2 rounded-sm px-1 text-sm text-text outline-none',
  'pointer-coarse:min-h-hit-touch data-hovered:bg-bg-subtle',
);
const radioDot = cn(
  'inline-flex size-4 shrink-0 items-center justify-center rounded-full border-(length:--border-check) border-border-strong',
  'group-data-selected:border-border-focus group-data-focus-visible:outline-2 group-data-focus-visible:outline-offset-2 group-data-focus-visible:outline-border-focus',
  "after:size-2 after:rounded-full after:content-[''] group-data-selected:after:bg-bg-accent",
);
const fieldLabel = 'text-xs font-medium text-text-secondary';

export interface RepeatSectionProps {
  choice: RepeatChoice | null;
  /** The due date the rule anchors on: the draft's, or today when the task has none yet. */
  dueDate: IsoDate;
  ctx: ViewerDateContext;
  onChange: (next: RepeatChoice | null) => void;
  /** Kitchen sink: open the custom editor. */
  defaultCustom?: boolean | undefined;
  /** Focus the selected option on mount (the "↻ Repeat" toggle opens the section). */
  autoFocus?: boolean | undefined;
}

/**
 * The date picker's "↻ Repeat" section (02 §7, FR-REC-1): the presets for the due date
 * (core `recurrencePresets`) and Custom… with frequency, interval, weekdays, monthly day or
 * nth/last weekday, an end (never, a date, a count) and the "after completion" basis. Every
 * change is a draft; the picker commits it with the date.
 */
export function RepeatSection({
  choice,
  dueDate,
  ctx,
  onChange,
  defaultCustom = false,
  autoFocus = false,
}: RepeatSectionProps) {
  const { t } = useTranslation('dates', { lng: ctx.locale });
  const ruleText = useRuleText(ctx);
  const presets = useMemo(() => recurrencePresets(dueDate), [dueDate]);
  const [custom, setCustom] = useState(defaultCustom || choice?.kind === 'custom');
  /**
   * The end the user chose, which the rule cannot hold yet: "On a date" before a date is
   * typed serialises as no end, and would otherwise read back as "Never".
   */
  const [chosenEnd, setChosenEnd] = useState<EndMode | null>(null);
  const selected = custom ? 'custom' : choice?.kind === 'preset' ? choice.id : '';
  const stored = fieldsOf(choice, dueDate);
  const fields: CustomFields =
    chosenEnd === 'until' && stored.end === 'never' ? { ...stored, end: 'until' } : stored;

  const setFields = (patch: Partial<CustomFields>) => {
    if (patch.end !== undefined) setChosenEnd(patch.end);
    const next = { ...fields, ...patch };
    onChange({ kind: 'custom', rule: ruleOf(next, dueDate), basis: next.basis });
  };

  return (
    <section
      aria-label={t('repeat.label')}
      className="flex flex-col gap-2"
      data-testid="repeat-section"
    >
      <div className="flex items-center gap-1">
        <Repeat
          className="size-4 shrink-0 text-text-muted"
          strokeWidth={iconStrokeWidth}
          aria-hidden
        />
        <span className="flex-1 ps-1 text-sm font-medium text-text">{t('repeat.label')}</span>
        <IconButton
          size="sm"
          icon={X}
          aria-label={t('repeat.remove')}
          onPress={() => onChange(null)}
        />
      </div>
      <RadioGroup
        aria-label={t('repeat.presets')}
        value={selected}
        onChange={(id) => {
          if (id === 'custom') {
            setCustom(true);
            onChange({ kind: 'custom', rule: ruleOf(fields, dueDate), basis: fields.basis });
            return;
          }
          setCustom(false);
          setChosenEnd(null);
          onChange({ kind: 'preset', id: id as RecurrencePresetId });
        }}
        className="flex flex-col"
      >
        {presets.map((preset, i) => (
          <Radio
            key={preset.id}
            value={preset.id}
            className={radioClass}
            autoFocus={autoFocus && (selected === preset.id || (selected === '' && i === 0))}
          >
            <span className={radioDot} aria-hidden />
            {ruleText(preset.rule)}
          </Radio>
        ))}
        <Radio value="custom" className={radioClass} autoFocus={autoFocus && selected === 'custom'}>
          <span className={radioDot} aria-hidden />
          {t('repeat.custom')}
        </Radio>
      </RadioGroup>
      {custom && <CustomEditor fields={fields} dueDate={dueDate} ctx={ctx} onChange={setFields} />}
      {custom && choice && (
        <p
          className="px-1 text-sm text-text-secondary"
          aria-live="polite"
          data-testid="repeat-summary"
        >
          {(() => {
            const stored = repeatFields(choice, dueDate);
            return stored ? ruleText(stored.recurrence, stored.recurrenceBasis) : '';
          })()}
        </p>
      )}
    </section>
  );
}

function CustomEditor({
  fields,
  dueDate,
  ctx,
  onChange,
}: {
  fields: CustomFields;
  dueDate: IsoDate;
  ctx: ViewerDateContext;
  onChange: (patch: Partial<CustomFields>) => void;
}) {
  const { t } = useTranslation('dates', { lng: ctx.locale });
  const text = useDateText(ctx);
  const weekdayOrder = ctx.weekStart === 1 ? WEEKDAYS : (['SU', ...WEEKDAYS.slice(0, 6)] as const);
  const sundayIndex = (w: Weekday) => (WEEKDAYS.indexOf(w) + 1) % 7;
  const dueWeekday = text.weekdayLong(sundayIndex(weekdayCode(dueDate)));
  const anchor = anchorOf(fields, dueDate);
  const anchorWeekday = text.weekdayLong(sundayIndex(anchor.nthDay.weekday));
  const nth = fields.monthly === 'nth' ? anchor.nthDay.nth : nthOf(dueDate);
  const hasNth = nth >= 1 && nth <= 4;
  const hasLast =
    fields.monthly === 'last' || addDays(dueDate, 7).slice(0, 7) !== dueDate.slice(0, 7);
  const [untilText, setUntilText] = useState(fields.until ? text.short(fields.until) : '');
  const parseCtx = {
    today: ctx.today,
    locale: ctx.locale,
    weekStart: ctx.weekStart,
    dateFormat: ctx.dateFormat,
  };
  const untilParsed = untilText.trim() ? parsePickerInput(untilText, parseCtx) : undefined;

  return (
    <div
      className="flex flex-col gap-3 rounded-sm border border-border p-2"
      data-testid="repeat-custom"
    >
      <div className="flex items-end gap-2">
        <NumberField
          value={fields.interval}
          minValue={1}
          maxValue={999}
          onChange={(interval) => {
            if (Number.isFinite(interval) && interval >= 1) onChange({ interval });
          }}
          className="flex w-16 flex-col gap-1"
        >
          <Label className={fieldLabel}>{t('repeat.every')}</Label>
          <Group>
            <AriaInput className="h-control w-full rounded-sm border border-border bg-bg-app px-2 text-sm text-text tabular-nums outline-none hover:border-border-strong focus-visible:border-border-focus pointer-coarse:h-hit-touch" />
          </Group>
        </NumberField>
        <Select
          label={t('repeat.unitLabel')}
          hideLabel
          options={RECURRENCE_FREQS.map((freq) => ({
            id: freq,
            label: t(`repeat.unit.${freq}` as 'repeat.unit.DAILY', { count: fields.interval }),
          }))}
          value={fields.freq}
          onChange={(freq) => onChange({ freq })}
          className="min-w-0 flex-1"
        />
      </div>
      {fields.basis === 'due' && fields.freq === 'WEEKLY' && (
        <fieldset className="flex min-w-0 flex-col gap-1">
          <legend className={cn(fieldLabel, 'mb-1')}>{t('repeat.on')}</legend>
          <div className="flex justify-between gap-0.5">
            {weekdayOrder.map((weekday) => {
              const on = fields.weekdays.includes(weekday);
              return (
                <ToggleButton
                  key={weekday}
                  isSelected={on}
                  aria-label={text.weekdayLong(sundayIndex(weekday))}
                  onChange={(next) => {
                    const days = next
                      ? [...fields.weekdays, weekday]
                      : fields.weekdays.filter((d) => d !== weekday);
                    // At least one day: the last one cannot be turned off.
                    if (days.length > 0) onChange({ weekdays: days });
                  }}
                  className={cn(
                    'inline-flex size-control-sm cursor-default items-center justify-center rounded-full text-xs font-medium outline-none',
                    'pointer-coarse:size-hit-touch',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus',
                    on
                      ? 'bg-bg-accent text-text-on-accent'
                      : 'border border-border text-text-secondary hover:bg-bg-subtle',
                  )}
                >
                  {text.weekdayNarrow(sundayIndex(weekday))}
                </ToggleButton>
              );
            })}
          </div>
        </fieldset>
      )}
      {fields.basis === 'due' && fields.freq === 'MONTHLY' && (
        <RadioGroup
          aria-label={t('repeat.monthlyLabel')}
          value={fields.monthly === 'nth' && !hasNth ? 'last' : fields.monthly}
          onChange={(monthly) => onChange({ monthly: monthly as MonthlyMode })}
          className="flex flex-col"
        >
          <Radio value="day" className={radioClass}>
            <span className={radioDot} aria-hidden />
            {t('repeat.monthlyDay', {
              day: t('repeat.ordinalDay', { day: anchor.monthDay }),
            })}
          </Radio>
          {hasNth && (
            <Radio value="nth" className={radioClass}>
              <span className={radioDot} aria-hidden />
              {t('repeat.monthlyNth', {
                nth: t(`repeat.nth.${nth}` as 'repeat.nth.1'),
                weekday: fields.monthly === 'nth' ? anchorWeekday : dueWeekday,
              })}
            </Radio>
          )}
          {hasLast && (
            <Radio value="last" className={radioClass}>
              <span className={radioDot} aria-hidden />
              {t('repeat.monthlyNth', {
                nth: t('repeat.nth.last'),
                weekday: fields.monthly === 'last' ? anchorWeekday : dueWeekday,
              })}
            </Radio>
          )}
        </RadioGroup>
      )}
      <Switch
        isSelected={fields.basis === 'completion'}
        onChange={(on) => onChange({ basis: on ? 'completion' : 'due' })}
        className="group/switch flex cursor-default items-center justify-between gap-3 text-sm text-text outline-none pointer-coarse:min-h-hit-touch"
      >
        {t('repeat.afterCompletion')}
        <span
          className={cn(
            'flex h-5 w-8 shrink-0 items-center rounded-full bg-text-muted p-0.5',
            'transition-colors duration-(--dur-fast) ease-standard',
            'group-data-selected/switch:bg-bg-accent',
            'group-data-focus-visible/switch:outline-2 group-data-focus-visible/switch:outline-offset-2 group-data-focus-visible/switch:outline-border-focus',
          )}
        >
          <span
            className={cn(
              'size-4 rounded-full bg-bg-elevated shadow-sm',
              'transition-transform duration-(--dur-fast) ease-standard motion-reduce:transition-none',
              'group-data-selected/switch:translate-x-3 rtl:group-data-selected/switch:-translate-x-3',
            )}
          />
        </span>
      </Switch>
      <div className="flex flex-col gap-2">
        <Select
          label={t('repeat.ends')}
          options={[
            { id: 'never', label: t('repeat.endNever') },
            { id: 'until', label: t('repeat.endUntil') },
            { id: 'count', label: t('repeat.endCount') },
          ]}
          value={fields.end}
          onChange={(end) =>
            onChange({
              end: end as EndMode,
              // A date typed before (then "Never", then back) applies again.
              ...(end === 'until' && untilParsed ? { until: untilParsed.date } : {}),
            })
          }
        />
        {fields.end === 'until' && (
          <div className="flex flex-col gap-1">
            <Input
              aria-label={t('repeat.untilLabel')}
              placeholder={t('repeat.untilPlaceholder')}
              value={untilText}
              onChange={(event) => {
                setUntilText(event.target.value);
                const parsed = parsePickerInput(event.target.value, parseCtx);
                if (parsed) onChange({ until: parsed.date });
              }}
              aria-invalid={untilParsed === null || undefined}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="min-h-5 px-0.5 text-sm text-text-secondary" aria-live="polite">
              {untilParsed === null
                ? t('popover.invalid')
                : fields.until
                  ? t('popover.preview', { date: text.short(fields.until) })
                  : ''}
            </p>
          </div>
        )}
        {fields.end === 'count' && (
          <NumberField
            value={fields.count}
            minValue={1}
            maxValue={9999}
            onChange={(count) => {
              if (Number.isFinite(count) && count >= 1) onChange({ count });
            }}
            className="flex flex-col gap-1"
          >
            <Label className={fieldLabel}>{t('repeat.countLabel')}</Label>
            <Group>
              <AriaInput className="h-control w-24 rounded-sm border border-border bg-bg-app px-2 text-sm text-text tabular-nums outline-none hover:border-border-strong focus-visible:border-border-focus pointer-coarse:h-hit-touch" />
            </Group>
          </NumberField>
        )}
      </div>
    </div>
  );
}
