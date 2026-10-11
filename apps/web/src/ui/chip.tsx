import { type TagColor, tagColorNames } from '@rooster/tokens';
import { cva } from 'class-variance-authority';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  Button as AriaButton,
  Tag as AriaTag,
  TagGroup as AriaTagGroup,
  TagList,
} from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/cn';
import { iconStrokeWidth } from './button';

export { type TagColor, tagColorNames };

/** Static class strings so Tailwind can see every tag colour (03 §2.4). */
export const tagColorClasses: Record<TagColor, string> = {
  gray: 'bg-tag-gray-bg text-tag-gray-fg',
  red: 'bg-tag-red-bg text-tag-red-fg',
  orange: 'bg-tag-orange-bg text-tag-orange-fg',
  amber: 'bg-tag-amber-bg text-tag-amber-fg',
  green: 'bg-tag-green-bg text-tag-green-fg',
  teal: 'bg-tag-teal-bg text-tag-teal-fg',
  blue: 'bg-tag-blue-bg text-tag-blue-fg',
  indigo: 'bg-tag-indigo-bg text-tag-indigo-fg',
  purple: 'bg-tag-purple-bg text-tag-purple-fg',
  pink: 'bg-tag-pink-bg text-tag-pink-fg',
};

/** 03 §3.7: 20 px tall, radius xs, 6 px padding, xs/500 text. */
export const chipVariants = cva(
  'inline-flex h-chip max-w-full shrink-0 items-center gap-0.5 truncate rounded-xs px-1.5 text-xs font-medium',
  {
    variants: { color: tagColorClasses },
    defaultVariants: { color: 'gray' },
  },
);

export interface ChipProps {
  color?: TagColor;
  children: ReactNode;
  className?: string | undefined;
}

/** A non-interactive tag chip, as shown in task rows. */
export function Chip({ color, children, className }: ChipProps) {
  return <span className={cn(chipVariants({ color }), className)}>{children}</span>;
}

export interface ChipItem {
  id: string;
  name: string;
  color: TagColor;
}

export interface ChipGroupProps {
  /** Accessible name of the group, e.g. "Tags". */
  label: string;
  items: readonly ChipItem[];
  /** Enables the remove buttons and Backspace/Delete removal. */
  onRemove?: (id: string) => void;
  className?: string | undefined;
}

/**
 * Removable chips (task pane tag editor). React Aria's TagGroup supplies arrow-key
 * navigation and keyboard removal; the 12 px "x" fades in on hover or focus without
 * moving anything, because its slot is always reserved.
 */
export function ChipGroup({ label, items, onRemove, className }: ChipGroupProps) {
  const { t } = useTranslation();
  return (
    <AriaTagGroup
      aria-label={label}
      className={cn(className)}
      {...(onRemove
        ? {
            onRemove: (keys) => {
              for (const key of keys) onRemove(String(key));
            },
          }
        : {})}
    >
      <TagList items={items} className="flex flex-wrap gap-1.5">
        {(item) => (
          <AriaTag
            id={item.id}
            textValue={item.name}
            className={cn(
              chipVariants({ color: item.color }),
              'group cursor-default outline-offset-2 focus-ring:outline-2 focus-ring:outline-border-focus',
              onRemove && 'pr-0.5',
            )}
          >
            {({ allowsRemoving }) => (
              <>
                <span className="truncate">{item.name}</span>
                {allowsRemoving && (
                  <AriaButton
                    slot="remove"
                    aria-label={t('tag.remove', { name: item.name })}
                    className="inline-flex size-4 items-center justify-center rounded-2xs opacity-0 transition-opacity duration-(--dur-fade) group-hover:opacity-100 group-focus-ring:opacity-100 focus-ring:opacity-100 pointer-coarse:opacity-100 hover:bg-bg-app/50"
                  >
                    <X className="size-3" strokeWidth={iconStrokeWidth} aria-hidden />
                  </AriaButton>
                )}
              </>
            )}
          </AriaTag>
        )}
      </TagList>
    </AriaTagGroup>
  );
}
