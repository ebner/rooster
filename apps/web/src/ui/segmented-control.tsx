import type { ReactNode } from 'react';
import { Label, Radio, RadioGroup, Text } from 'react-aria-components';
import { cn } from '../lib/cn';

export interface SegmentedOption<K extends string> {
  id: K;
  label: ReactNode;
  /** Rendered with `lang` so screen readers pronounce endonyms correctly. */
  lang?: string;
}

export interface SegmentedControlProps<K extends string> {
  label: string;
  hideLabel?: boolean;
  description?: string | undefined;
  options: readonly SegmentedOption<K>[];
  value: K;
  onChange: (value: K) => void;
  isDisabled?: boolean;
  className?: string | undefined;
  'data-force'?: string;
}

/**
 * A single-choice segmented control (a radio group, so arrows move the choice).
 * Used for short, mutually exclusive settings: language, week start, formats.
 */
export function SegmentedControl<K extends string>({
  label,
  hideLabel = false,
  description,
  options,
  value,
  onChange,
  isDisabled = false,
  className,
  'data-force': force,
}: SegmentedControlProps<K>) {
  return (
    <RadioGroup
      value={value}
      onChange={(next) => {
        const option = options.find((o) => o.id === next);
        if (option) onChange(option.id);
      }}
      isDisabled={isDisabled}
      orientation="horizontal"
      className={cn('flex flex-col gap-1.5', className)}
    >
      <Label className={cn('text-sm font-medium text-text-secondary', hideLabel && 'sr-only')}>
        {label}
      </Label>
      <div className="inline-flex w-fit max-w-full gap-0.5 rounded-sm bg-bg-muted p-0.5">
        {options.map((option) => (
          <Radio
            key={option.id}
            value={option.id}
            {...(option.lang ? { lang: option.lang } : {})}
            {...(force && option.id === value ? { 'data-force': force } : {})}
            className={cn(
              'inline-flex h-control-sm min-w-0 cursor-default items-center justify-center rounded-xs px-3 text-sm font-medium whitespace-nowrap text-text-secondary',
              'pointer-coarse:h-hit-touch',
              'transition-colors duration-(--dur-fast) ease-standard hover:text-text',
              'data-selected:bg-bg-elevated data-selected:text-text data-selected:shadow-sm',
              'data-disabled:cursor-not-allowed data-disabled:hover:text-text-secondary',
              'outline-offset-2 focus-ring:outline-2 focus-ring:outline-border-focus',
            )}
          >
            {option.label}
          </Radio>
        ))}
      </div>
      {description && (
        <Text slot="description" className="text-sm text-text-muted">
          {description}
        </Text>
      )}
    </RadioGroup>
  );
}
