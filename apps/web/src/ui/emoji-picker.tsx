import { useId } from 'react';
import { ListBox, ListBoxItem } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/cn';
import { initials } from './avatar';

/** 23 curated emoji plus the initials cell: three rows of eight (WP 1.4). */
export const curatedEmoji = [
  '🏡',
  '🏢',
  '💼',
  '🚀',
  '🌱',
  '🎯',
  '📚',
  '🎨',
  '🛠️',
  '💡',
  '🧪',
  '🏃',
  '🍳',
  '🎵',
  '✈️',
  '🐓',
  '🌍',
  '❤️',
  '⭐',
  '🔥',
  '🧩',
  '📦',
  '🎓',
] as const;

/** The key of the "no emoji, use initials" cell. */
const initialsKey = 'initials';

export interface EmojiPickerProps {
  label: string;
  value: string | null;
  onChange: (emoji: string | null) => void;
  /** Name whose initials preview the "no emoji" choice. */
  name: string;
  isDisabled?: boolean;
  className?: string | undefined;
}

const cellClass = cn(
  'inline-flex size-control cursor-default items-center justify-center rounded-sm text-md leading-none outline-none',
  'pointer-coarse:size-hit-touch',
  'transition-colors duration-(--dur-fast) ease-standard hover:bg-bg-subtle',
  'data-selected:bg-bg-selected data-selected:ring-2 data-selected:ring-selection-bar data-selected:ring-inset',
  'outline-offset-2 data-focus-visible:outline-2 data-focus-visible:outline-border-focus',
  'data-disabled:cursor-not-allowed data-disabled:opacity-50',
);

/** A grid of curated emoji (arrow keys move in two dimensions) plus an initials cell. */
export function EmojiPicker({
  label,
  value,
  onChange,
  name,
  isDisabled = false,
  className,
}: EmojiPickerProps) {
  const { t } = useTranslation();
  const labelId = useId();
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <span id={labelId} className="text-sm font-medium text-text-secondary">
        {label}
      </span>
      <ListBox
        aria-labelledby={labelId}
        layout="grid"
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={[value ?? initialsKey]}
        onSelectionChange={(keys) => {
          if (keys === 'all') return;
          const [key] = [...keys];
          if (key === undefined) return;
          onChange(key === initialsKey ? null : String(key));
        }}
        {...(isDisabled ? { disabledKeys: [initialsKey, ...curatedEmoji] } : {})}
        className="flex flex-wrap gap-1"
      >
        <ListBoxItem
          id={initialsKey}
          textValue={t('emoji.initials')}
          aria-label={t('emoji.initials')}
          className={cellClass}
        >
          <span aria-hidden className="text-xs font-semibold text-text-secondary">
            {initials(name || '?')}
          </span>
        </ListBoxItem>
        {curatedEmoji.map((emoji) => (
          <ListBoxItem key={emoji} id={emoji} textValue={emoji} className={cellClass}>
            {emoji}
          </ListBoxItem>
        ))}
      </ListBox>
    </div>
  );
}
