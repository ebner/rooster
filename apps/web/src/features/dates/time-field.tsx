import { formatTime } from '@rooster/core/dates';
import { Clock, X } from 'lucide-react';
import { type KeyboardEvent, useMemo } from 'react';
import { Input as AriaInput, ComboBox, ListBox, Popover } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { iconStrokeWidth } from '../../ui/button';
import { IconButton } from '../../ui/icon-button';
import { inputVariants } from '../../ui/input';
import { overlayOffsetPx } from '../../ui/popover';
import { ListBoxOption, listBoxPopoverClass } from '../../ui/select';
import type { ViewerDateContext } from './types';

/** Every quarter hour, `00:00` … `23:45` (02 §7: 15-minute suggestions). */
export const quarterHours: readonly string[] = Array.from({ length: 96 }, (_, i) => {
  const hour = String(Math.floor(i / 4)).padStart(2, '0');
  const minute = String((i % 4) * 15).padStart(2, '0');
  return `${hour}:${minute}`;
});

/** Eight suggestion rows of `--h-control` (32 px) before the list scrolls. */
const suggestionListMaxHeightPx = 256;

const timePattern = /^(\d{1,2})(?:[:.]?(\d{2}))?\s*(am|pm|fm|em)?$/;

/**
 * Reads a typed time: `14`, `14:30`, `1430`, `14.30`, `2pm`, `2:30 pm` (and Swedish
 * `fm`/`em`). Returns `HH:MM`, or null when it is not a time.
 */
export function parseTimeInput(input: string): string | null {
  const m = timePattern.exec(input.trim().toLowerCase().replace(/\s+/g, ' '));
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  const meridiem = m[3];
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    const pm = meridiem === 'pm' || meridiem === 'em';
    hour = (hour % 12) + (pm ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export interface TimeFieldProps {
  ctx: ViewerDateContext;
  value: string;
  onChange: (text: string) => void;
  /** Enter with the suggestion list closed. */
  onSubmit: () => void;
  onRemove: () => void;
  isInvalid?: boolean | undefined;
  autoFocus?: boolean | undefined;
}

/** The "+ Time" sub-mode: an HH:MM combobox with quarter-hour suggestions. */
export function TimeField({
  ctx,
  value,
  onChange,
  onSubmit,
  onRemove,
  isInvalid,
  autoFocus,
}: TimeFieldProps) {
  const { t } = useTranslation('dates', { lng: ctx.locale });
  const items = useMemo(() => quarterHours.map((id) => ({ id })), []);

  // Capture phase: decide before React Aria's combobox handles the key. With an option
  // highlighted, Enter picks it (the list closes); otherwise Enter commits the popover.
  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    const input = event.target as HTMLElement;
    if (input.getAttribute('aria-activedescendant')) return;
    event.preventDefault();
    event.stopPropagation();
    onSubmit();
  };

  return (
    <div className="flex items-center gap-1.5" onKeyDownCapture={onKeyDownCapture}>
      <Clock
        className="size-4 shrink-0 text-text-muted"
        strokeWidth={iconStrokeWidth}
        aria-hidden
      />
      <ComboBox
        aria-label={t('time.label')}
        defaultItems={items}
        inputValue={value}
        onInputChange={onChange}
        onSelectionChange={(key) => {
          if (key !== null) onChange(String(key));
        }}
        defaultFilter={(textValue, input) =>
          textValue.replace(':', '').startsWith(input.replace(/[:.]/, '').trim())
        }
        allowsCustomValue
        menuTrigger="focus"
        isInvalid={isInvalid ?? false}
        className="w-16"
      >
        <AriaInput
          placeholder={t('time.placeholder')}
          autoFocus={autoFocus}
          className={cn(inputVariants(), 'h-control-sm px-2 text-sm tabular-nums')}
        />
        <Popover
          offset={overlayOffsetPx}
          maxHeight={suggestionListMaxHeightPx}
          className={listBoxPopoverClass}
        >
          <ListBox aria-label={t('time.suggestions')} className="outline-none">
            {(item: { id: string }) => (
              <ListBoxOption id={item.id} textValue={item.id} className="tabular-nums">
                {ctx.timeFormat === '24h' ? item.id : formatTime(item.id, ctx.locale, '12h')}
              </ListBoxOption>
            )}
          </ListBox>
        </Popover>
      </ComboBox>
      <IconButton size="sm" icon={X} aria-label={t('time.remove')} onPress={onRemove} />
    </div>
  );
}
