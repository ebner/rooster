import { Check, ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  Button as AriaButton,
  Select as AriaSelect,
  Label,
  ListBox,
  ListBoxItem,
  type ListBoxItemProps,
  Popover,
  SelectValue,
  Text,
} from 'react-aria-components';
import { cn } from '../lib/cn';
import { iconStrokeWidth } from './button';
import { overlayOffsetPx, popoverMotion, popoverSurface } from './popover';

/** The closed field: same metrics as an input (03 §3.6) with a trailing chevron. */
export const fieldButtonClass = cn(
  'flex h-control w-full min-w-0 cursor-default items-center gap-2 rounded-sm border border-border bg-bg-app px-3 text-start text-base text-text',
  'pointer-coarse:h-hit-touch pointer-coarse:text-md',
  'transition-colors duration-(--dur-fast) ease-standard hover:border-border-strong',
  'focus-ring:border-border-focus data-pressed:border-border-strong',
  'data-disabled:cursor-not-allowed data-disabled:bg-bg-subtle data-disabled:text-text-disabled data-disabled:hover:border-border',
);

/** Popover list rows, shared by Select and ComboBox: 32 px, radius sm, check when selected. */
export function ListBoxOption({
  children,
  className,
  ...props
}: Omit<ListBoxItemProps, 'children' | 'className'> & {
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <ListBoxItem
      {...props}
      className={cn(
        'flex h-control cursor-default items-center gap-2 rounded-sm px-2 text-sm text-text outline-none',
        'pointer-coarse:h-hit-touch',
        'data-focused:bg-bg-muted data-pressed:bg-bg-muted',
        'data-disabled:cursor-not-allowed data-disabled:text-text-disabled',
        className,
      )}
    >
      {({ isSelected }) => (
        <>
          <span className="flex min-w-0 flex-1 items-center gap-2 truncate">{children}</span>
          <Check
            className={cn('size-4 shrink-0 text-text-secondary', !isSelected && 'invisible')}
            strokeWidth={iconStrokeWidth}
            aria-hidden
          />
        </>
      )}
    </ListBoxItem>
  );
}

export const listBoxPopoverClass = cn(
  popoverSurface,
  popoverMotion,
  'min-w-(--trigger-width) overflow-auto',
);

export interface SelectOption<K extends string> {
  id: K;
  label: string;
}

export interface SelectProps<K extends string> {
  label: string;
  hideLabel?: boolean;
  description?: string | undefined;
  options: readonly SelectOption<K>[];
  value: K;
  onChange: (value: K) => void;
  isDisabled?: boolean;
  className?: string | undefined;
  'data-force'?: string;
}

/** A labelled single select (React Aria Select + ListBox in an anchored popover). */
export function Select<K extends string>({
  label,
  hideLabel = false,
  description,
  options,
  value,
  onChange,
  isDisabled = false,
  className,
  'data-force': force,
}: SelectProps<K>) {
  return (
    <AriaSelect
      selectedKey={value}
      onSelectionChange={(key) => {
        const option = options.find((o) => o.id === key);
        if (option) onChange(option.id);
      }}
      isDisabled={isDisabled}
      className={cn('flex flex-col gap-1.5', className)}
    >
      <Label className={cn('text-sm font-medium text-text-secondary', hideLabel && 'sr-only')}>
        {label}
      </Label>
      <AriaButton className={fieldButtonClass} {...(force ? { 'data-force': force } : {})}>
        {/* Render the plain label; the default would clone the option row (with its check). */}
        <SelectValue className="min-w-0 flex-1 truncate">
          {({ selectedText }) => selectedText}
        </SelectValue>
        <ChevronDown
          className="size-4 shrink-0 text-text-secondary"
          strokeWidth={iconStrokeWidth}
          aria-hidden
        />
      </AriaButton>
      {description && (
        <Text slot="description" className="text-sm text-text-muted">
          {description}
        </Text>
      )}
      <Popover offset={overlayOffsetPx} className={listBoxPopoverClass}>
        <ListBox items={options} className="outline-none">
          {(option) => (
            <ListBoxOption id={option.id} textValue={option.label}>
              {option.label}
            </ListBoxOption>
          )}
        </ListBox>
      </Popover>
    </AriaSelect>
  );
}
