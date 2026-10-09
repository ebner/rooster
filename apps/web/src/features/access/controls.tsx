import { Check, Minus } from 'lucide-react';
import type { ReactNode } from 'react';
import { Checkbox, Label, Radio, RadioGroup } from 'react-aria-components';
import { cn } from '../../lib/cn';

/** The 16 px square box shared by `FormCheckbox` and the group picker rows. */
export function CheckSquare({
  checked,
  disabled = false,
  indeterminate = false,
}: {
  checked: boolean;
  disabled?: boolean | undefined;
  indeterminate?: boolean | undefined;
}) {
  const Icon = indeterminate ? Minus : Check;
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex size-4 shrink-0 items-center justify-center rounded-xs border-(length:--border-check)',
        'transition-colors duration-(--dur-fast) ease-standard',
        checked || indeterminate
          ? 'border-bg-accent bg-bg-accent text-text-on-accent'
          : 'border-border-strong bg-bg-app text-transparent',
        disabled && 'opacity-50',
      )}
    >
      <Icon className="size-3" strokeWidth={3} />
    </span>
  );
}

export interface FormCheckboxProps {
  isSelected: boolean;
  onChange: (value: boolean) => void;
  isDisabled?: boolean | undefined;
  children: ReactNode;
  description?: ReactNode;
  /** Trailing content in the label row, e.g. an "Included" note. */
  aside?: ReactNode;
  className?: string | undefined;
  'data-force'?: string;
  'data-testid'?: string;
}

/** A labelled square checkbox (React Aria): the whole row toggles; 44 px tall on touch. */
export function FormCheckbox({
  isSelected,
  onChange,
  isDisabled,
  children,
  description,
  aside,
  className,
  'data-force': force,
  'data-testid': testId,
}: FormCheckboxProps) {
  return (
    <Checkbox
      isSelected={isSelected}
      onChange={onChange}
      isDisabled={isDisabled ?? false}
      {...(force ? { 'data-force': force } : {})}
      {...(testId ? { 'data-testid': testId } : {})}
      className={cn(
        // Relative: React Aria's visually hidden input stays inside the row, so focusing it
        // scrolls only as far as the row (ChoiceGroup's radios likewise).
        'group relative flex cursor-default items-start gap-3 rounded-sm py-1.5 text-sm text-text outline-none',
        'pointer-coarse:min-h-hit-touch pointer-coarse:items-center',
        'data-disabled:cursor-not-allowed',
        className,
      )}
    >
      {({ isSelected: checked, isDisabled: disabled }) => (
        <>
          <span
            className={cn(
              'mt-0.5 inline-flex rounded-xs outline-offset-2 outline-border-focus pointer-coarse:mt-0',
              'group-focus-ring:outline-2',
            )}
          >
            <CheckSquare checked={checked} disabled={disabled} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-x-2">
              <span className={cn('font-medium', disabled && !checked && 'text-text-disabled')}>
                {children}
              </span>
              {aside}
            </span>
            {description && <span className="text-text-muted">{description}</span>}
          </span>
        </>
      )}
    </Checkbox>
  );
}

export interface ChoiceOption<K extends string> {
  id: K;
  label: string;
  isDisabled?: boolean | undefined;
}

export interface ChoiceGroupProps<K extends string> {
  label: string;
  options: readonly ChoiceOption<K>[];
  value: K;
  onChange: (value: K) => void;
  className?: string | undefined;
  'data-testid'?: string;
}

/**
 * A segmented single choice (a radio group: arrows move it) whose options can be disabled one
 * by one, which narrow-only editing needs. Wraps on narrow phones instead of overflowing.
 */
export function ChoiceGroup<K extends string>({
  label,
  options,
  value,
  onChange,
  className,
  'data-testid': testId,
}: ChoiceGroupProps<K>) {
  return (
    <RadioGroup
      value={value}
      onChange={(next) => {
        const option = options.find((o) => o.id === next);
        if (option) onChange(option.id);
      }}
      orientation="horizontal"
      {...(testId ? { 'data-testid': testId } : {})}
      className={cn(
        'flex flex-col gap-1.5 tablet:flex-row tablet:items-center tablet:gap-3',
        className,
      )}
    >
      <Label className="shrink-0 text-sm text-text-secondary tablet:w-label-col">{label}</Label>
      <div className="inline-flex w-fit max-w-full flex-wrap gap-0.5 rounded-sm bg-bg-muted p-0.5">
        {options.map((option) => (
          <Radio
            key={option.id}
            value={option.id}
            isDisabled={option.isDisabled ?? false}
            className={cn(
              'relative inline-flex h-control-sm min-w-0 cursor-default items-center justify-center rounded-xs px-3 text-sm font-medium whitespace-nowrap text-text-secondary',
              'pointer-coarse:h-hit-touch',
              'transition-colors duration-(--dur-fast) ease-standard hover:text-text',
              'data-selected:bg-bg-elevated data-selected:text-text data-selected:shadow-sm',
              'data-disabled:cursor-not-allowed data-disabled:text-text-disabled data-disabled:hover:text-text-disabled',
              'outline-offset-2 focus-ring:outline-2 focus-ring:outline-border-focus',
            )}
          >
            {option.label}
          </Radio>
        ))}
      </div>
    </RadioGroup>
  );
}
