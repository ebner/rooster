import { dueInstant, formatTime } from '@rooster/core/dates';
import { REMINDERS_MAX } from '@rooster/core/limits';
import {
  parseReminderOffset,
  type ReminderOwner,
  type ReminderSpec,
  resolveFireAt,
} from '@rooster/core/reminders';
import type { Reminder } from '@rooster/core/schemas';
import { Bell, Plus } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, iconStrokeWidth } from '../../ui/button';
import { Input } from '../../ui/input';
import { formatInstant } from './date-text';
import { parsePickerInput } from './parser';
import { offsetText, ReminderChips, type Translate, useReminderViews } from './reminder-chips';
import type { DueValue, ViewerDateContext } from './types';

export interface ReminderSectionProps {
  /** The user's reminders on the task; undefined while they load. */
  items: readonly Reminder[] | undefined;
  /** The due the reminders resolve against (the picker's draft). */
  due: DueValue;
  owner: ReminderOwner;
  ctx: ViewerDateContext;
  onAdd: (spec: ReminderSpec) => void;
  onRemove: (reminder: Reminder) => void;
  /** Focus the first preset on mount (Alt+R, "Add reminder"). */
  autoFocus?: boolean | undefined;
  /** Kitchen sink: open "Custom…" with this text. */
  defaultCustom?: string | undefined;
}

interface Preset {
  id: string;
  offsetMinutes: number;
  label: string;
}

/** What the custom input means: a spec to add, or why it can't be added. */
type CustomParse =
  | { ok: true; spec: ReminderSpec; preview: string }
  | { ok: false; error: 'invalid' | 'needsDue' | 'past' };

/**
 * The date picker's "🔔 Reminder" section (02 §7, FR-REM-1/4): chips for the user's reminders,
 * then presets (at due time or on the day, 15 min, 1 hour, 1 day before) and Custom…, which
 * takes `15m`/`1h`/`1d`/`due` or a date and time ("fri 14:00"). Without a due date only
 * absolute reminders are offered. Adding one keeps the picker open.
 */
export function ReminderSection({
  items,
  due,
  owner,
  ctx,
  onAdd,
  onRemove,
  autoFocus = false,
  defaultCustom,
}: ReminderSectionProps) {
  const { t } = useTranslation('dates', { lng: ctx.locale });
  const views = useReminderViews(items, due, ctx);
  const [customOpen, setCustomOpen] = useState(defaultCustom !== undefined);
  const [custom, setCustom] = useState(defaultCustom ?? '');
  const hasDue = Boolean(due.dueDate);
  const allDay = !due.dueTime;
  const full = (items?.length ?? 0) >= REMINDERS_MAX;
  const existingOffsets = new Set(
    (items ?? []).flatMap((r) => (r.kind === 'relative' ? [r.offsetMinutes] : [])),
  );
  const presets: Preset[] = hasDue
    ? [
        {
          id: 'due',
          offsetMinutes: 0,
          label: allDay
            ? t('reminder.onTheDayAt', {
                time: formatTime(owner.allDayReminderTime, ctx.locale, ctx.timeFormat),
              })
            : t('reminder.atDue'),
        },
        { id: '15m', offsetMinutes: 15, label: t('reminder.preset15m') },
        { id: '1h', offsetMinutes: 60, label: t('reminder.preset1h') },
        { id: '1d', offsetMinutes: 1440, label: t('reminder.preset1d') },
      ]
    : [];

  const parseCustom = (raw: string): CustomParse | undefined => {
    const text = raw.trim();
    if (!text) return undefined;
    const offset = parseReminderOffset(text);
    if (offset !== null) {
      if (!hasDue) return { ok: false, error: 'needsDue' };
      const fireAt = resolveFireAt(
        { kind: 'relative', offsetMinutes: offset, remindAt: null },
        due,
        owner,
      );
      const when = fireAt === null ? '' : formatInstant(fireAt, ctx);
      return {
        ok: true,
        spec: { offsetMinutes: offset },
        preview: t('reminder.chip', { offset: offsetText(t as Translate, offset, allDay), when }),
      };
    }
    const parsed = parsePickerInput(text, {
      today: ctx.today,
      locale: ctx.locale,
      weekStart: ctx.weekStart,
      dateFormat: ctx.dateFormat,
    });
    if (!parsed) return { ok: false, error: 'invalid' };
    const at = dueInstant(parsed.date, parsed.time ?? owner.allDayReminderTime, ctx.timezone);
    // 06 §2.4: an absolute reminder more than a minute in the past is refused.
    if (at < ctx.nowMs - 60_000) return { ok: false, error: 'past' };
    return { ok: true, spec: { at }, preview: formatInstant(at, ctx) };
  };
  const parsed = parseCustom(custom);
  const firstPreset = useRef<HTMLButtonElement>(null);
  const firstEnabled = presets.findIndex((p) => !existingOffsets.has(p.offsetMinutes));
  const loaded = items !== undefined;
  // Alt+R / "Add reminder": the first preset takes focus once the reminders are known (the
  // presets are disabled while they load), which also scrolls the section into view.
  useEffect(() => {
    if (autoFocus && loaded) firstPreset.current?.focus();
  }, [autoFocus, loaded]);

  const addCustom = () => {
    if (!parsed?.ok || full) return;
    onAdd(parsed.spec);
    setCustom('');
  };

  const onCustomKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    // Enter adds the reminder; it never commits the date picker underneath.
    event.preventDefault();
    event.stopPropagation();
    addCustom();
  };

  return (
    <section
      aria-label={t('reminder.label')}
      className="flex flex-col gap-2"
      data-testid="reminder-section"
    >
      <div className="flex items-center gap-1">
        <Bell
          className="size-4 shrink-0 text-text-muted"
          strokeWidth={iconStrokeWidth}
          aria-hidden
        />
        <span className="flex-1 ps-1 text-sm font-medium text-text">{t('reminder.label')}</span>
      </div>
      {items === undefined ? (
        <p className="text-sm text-text-muted">{t('reminder.loading')}</p>
      ) : (
        <ReminderChips views={views} ctx={ctx} onRemove={onRemove} />
      )}
      {full ? (
        <p className="text-sm text-text-muted">{t('reminder.full', { count: REMINDERS_MAX })}</p>
      ) : (
        <>
          {presets.length > 0 ? (
            <fieldset className="grid grid-cols-2 gap-1.5">
              <legend className="sr-only">{t('reminder.presets')}</legend>
              {presets.map((preset, i) => {
                const exists = existingOffsets.has(preset.offsetMinutes);
                return (
                  <Button
                    key={preset.id}
                    size="sm"
                    variant="secondary"
                    isDisabled={exists || items === undefined}
                    {...(i === firstEnabled ? { ref: firstPreset } : {})}
                    onPress={() => onAdd({ offsetMinutes: preset.offsetMinutes })}
                    className="[&>span]:min-w-0 [&>span]:truncate"
                  >
                    {preset.label}
                  </Button>
                );
              })}
            </fieldset>
          ) : (
            <p className="text-sm text-text-muted">{t('reminder.absoluteOnly')}</p>
          )}
          {customOpen || presets.length === 0 ? (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5">
                <Input
                  aria-label={t('reminder.customLabel')}
                  placeholder={t(
                    hasDue ? 'reminder.customPlaceholder' : 'reminder.customPlaceholderAbsolute',
                  )}
                  value={custom}
                  onChange={(event) => setCustom(event.target.value)}
                  onKeyDown={onCustomKeyDown}
                  autoFocus={
                    (autoFocus && presets.length === 0) ||
                    (customOpen && defaultCustom === undefined)
                  }
                  aria-invalid={(parsed && !parsed.ok) || undefined}
                  autoComplete="off"
                  spellCheck={false}
                  className="h-control-sm"
                />
                <Button
                  size="sm"
                  variant="secondary"
                  isDisabled={!parsed?.ok || items === undefined}
                  onPress={addCustom}
                >
                  {t('reminder.add')}
                </Button>
              </div>
              <p
                className="min-h-5 px-0.5 text-sm text-text-secondary"
                aria-live="polite"
                data-testid="reminder-custom-status"
              >
                {parsed === undefined
                  ? ''
                  : parsed.ok
                    ? t('popover.preview', { date: parsed.preview })
                    : t(`reminder.error.${parsed.error}` as 'reminder.error.invalid')}
              </p>
            </div>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              icon={Plus}
              onPress={() => setCustomOpen(true)}
              className="self-start"
            >
              {t('reminder.custom')}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
