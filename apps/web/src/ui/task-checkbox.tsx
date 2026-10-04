import { Check } from 'lucide-react';
import { useState } from 'react';
import {
  Checkbox as AriaCheckbox,
  type CheckboxProps as AriaCheckboxProps,
} from 'react-aria-components';
import { cn } from '../lib/cn';

export interface TaskCheckboxProps
  extends Omit<AriaCheckboxProps, 'className' | 'children' | 'isIndeterminate' | 'aria-label'> {
  /** Required: e.g. t('task.complete', { title }) — the circle has no visible label. */
  'aria-label': string;
  className?: string | undefined;
  'data-force'?: string;
}

/**
 * 03 §3.1: the round task checkbox. 18 px circle inside a 32 px (desktop) or 44 px
 * (touch) hit area. Completing it pops (scale 1 → 1.2 → 1, spring); the pop is a
 * zero-length animation under reduced motion because --dur-pop becomes 0 ms.
 */
export function TaskCheckbox({ className, onChange, ...props }: TaskCheckboxProps) {
  // Pop only on a user-driven completion, never for rows that render already done.
  const [popKey, setPopKey] = useState(0);
  return (
    <AriaCheckbox
      {...props}
      onChange={(isSelected) => {
        if (isSelected) setPopKey((k) => k + 1);
        onChange?.(isSelected);
      }}
      className={cn(
        'group relative inline-flex size-hit shrink-0 cursor-default items-center justify-center rounded-full',
        'pointer-coarse:size-hit-touch',
        'data-disabled:cursor-not-allowed',
        className,
      )}
    >
      {({ isSelected, isDisabled }) => (
        <span
          key={popKey}
          className={cn(
            'inline-flex size-checkbox items-center justify-center rounded-full border-(length:--border-check)',
            'border-border-strong bg-bg-app text-transparent',
            'transition-colors duration-(--dur-fast) ease-standard',
            'outline-offset-2 outline-border-focus group-focus-ring:outline-2',
            !isDisabled &&
              !isSelected &&
              'group-hover:border-border-hover group-hover:text-icon-subtle',
            isDisabled && 'opacity-50',
            isSelected && 'border-check-done bg-check-done text-text-inverse',
            isSelected && popKey > 0 && 'motion-safe:animate-check-pop',
          )}
        >
          <Check className="size-3" strokeWidth={3} aria-hidden />
        </span>
      )}
    </AriaCheckbox>
  );
}
