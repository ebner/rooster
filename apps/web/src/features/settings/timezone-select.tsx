import { ChevronDown } from 'lucide-react';
import { useMemo } from 'react';
import {
  Button as AriaButton,
  Input as AriaInput,
  ComboBox,
  Label,
  ListBox,
  Popover,
  Text,
} from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { iconStrokeWidth } from '../../ui/button';
import { inputVariants } from '../../ui/input';
import { overlayOffsetPx } from '../../ui/popover';
import { ListBoxOption, listBoxPopoverClass } from '../../ui/select';

export interface TimezoneOption {
  id: string;
  /** "Europe/Stockholm" → "Europe / Stockholm" style label without underscores. */
  label: string;
  /** e.g. "GMT+2" at the time of rendering. */
  offset: string;
}

/** Every IANA zone the runtime knows, plus UTC (which `supportedValuesOf` omits). */
export function listTimezones(now: number = Date.now()): TimezoneOption[] {
  const zones = new Set<string>(['UTC', ...Intl.supportedValuesOf('timeZone')]);
  return [...zones].map((id) => ({
    id,
    label: id.replaceAll('_', ' '),
    offset: offsetOf(id, now),
  }));
}

function offsetOf(timeZone: string, now: number): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'shortOffset',
    }).formatToParts(now);
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

/** Case-insensitive match on the zone path, ignoring "_" vs " " and "/" (e.g. "new york"). */
export function matchesTimezone(option: TimezoneOption, query: string): boolean {
  const needle = query.trim().toLowerCase().replaceAll('_', ' ');
  if (!needle) return true;
  const haystack = `${option.label} ${option.offset}`.toLowerCase().replaceAll('/', ' ');
  return needle.split(/\s+/).every((word) => haystack.includes(word.replaceAll('/', ' ')));
}

export interface TimezoneSelectProps {
  value: string;
  onChange: (timezone: string) => void;
  description?: string | undefined;
  className?: string | undefined;
}

/** A searchable select over `Intl.supportedValuesOf('timeZone')` (FR-SET-1). */
export function TimezoneSelect({ value, onChange, description, className }: TimezoneSelectProps) {
  const { t } = useTranslation('settings');
  const options = useMemo(() => listTimezones(), []);
  const byLabel = useMemo(() => new Map(options.map((o) => [o.label, o])), [options]);
  const selected = options.find((o) => o.id === value);
  return (
    <ComboBox
      defaultItems={options}
      selectedKey={value}
      defaultInputValue={selected?.label ?? value}
      onSelectionChange={(key) => {
        if (key !== null && String(key) !== value) onChange(String(key));
      }}
      defaultFilter={(textValue, input) => {
        const option = byLabel.get(textValue);
        return option ? matchesTimezone(option, input) : false;
      }}
      menuTrigger="focus"
      className={cn('flex flex-col gap-1.5', className)}
    >
      <Label className="text-sm font-medium text-text-secondary">{t('profile.timezone')}</Label>
      <div className="relative">
        <AriaInput className={cn(inputVariants(), 'pe-8')} />
        <AriaButton
          aria-label={t('profile.timezoneShowAll')}
          className="absolute inset-y-0 end-0 flex w-8 cursor-default items-center justify-center rounded-e-sm text-text-secondary"
        >
          <ChevronDown className="size-4" strokeWidth={iconStrokeWidth} aria-hidden />
        </AriaButton>
      </div>
      {description && (
        <Text slot="description" className="text-sm text-text-muted">
          {description}
        </Text>
      )}
      <Popover offset={overlayOffsetPx} className={listBoxPopoverClass}>
        <ListBox
          className="outline-none"
          renderEmptyState={() => (
            <p className="px-2 py-1.5 text-sm text-text-muted">{t('profile.timezoneNone')}</p>
          )}
        >
          {(option: TimezoneOption) => (
            <ListBoxOption id={option.id} textValue={option.label}>
              <span className="truncate">{option.label}</span>
              <span className="ms-auto shrink-0 text-xs text-text-muted tabular-nums">
                {option.offset}
              </span>
            </ListBoxOption>
          )}
        </ListBox>
      </Popover>
    </ComboBox>
  );
}
