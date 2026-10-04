import type { LucideIcon } from 'lucide-react';
import { Button as AriaButton, type ButtonProps as AriaButtonProps } from 'react-aria-components';
import { cn } from '../lib/cn';
import {
  type ButtonSize,
  type ButtonVariant,
  buttonVariants,
  iconStrokeWidth,
  Spinner,
} from './button';
import { Tooltip } from './tooltip';

const squareSize: Record<ButtonSize, string> = {
  sm: 'size-control-sm px-0',
  md: 'size-control px-0',
  lg: 'size-control-lg px-0',
};

export interface IconButtonProps
  extends Omit<AriaButtonProps, 'className' | 'children' | 'isPending' | 'aria-label'> {
  /** Required: the accessible name, also shown as the tooltip (03 §3.5). */
  'aria-label': string;
  icon: LucideIcon;
  variant?: Exclude<ButtonVariant, 'link'>;
  size?: ButtonSize;
  /** Shortcut shown in the tooltip, e.g. `"Mod+K"`. */
  shortcut?: string | undefined;
  isLoading?: boolean;
  /** Forces the tooltip open (kitchen sink) or closed. */
  isTooltipOpen?: boolean;
  className?: string | undefined;
  'data-force'?: string;
}

/** Square, ghost by default, always labelled and always with a tooltip. */
export function IconButton({
  'aria-label': label,
  icon: Icon,
  variant = 'ghost',
  size = 'md',
  shortcut,
  isLoading = false,
  isTooltipOpen,
  className,
  ...props
}: IconButtonProps) {
  return (
    <Tooltip
      content={label}
      shortcut={shortcut}
      {...(isTooltipOpen === undefined ? {} : { isOpen: isTooltipOpen })}
    >
      <AriaButton
        {...props}
        aria-label={label}
        isPending={isLoading}
        className={cn(buttonVariants({ variant, size }), squareSize[size], className)}
      >
        {isLoading ? (
          <Spinner />
        ) : (
          <Icon className="size-4" strokeWidth={iconStrokeWidth} aria-hidden />
        )}
      </AriaButton>
    </Tooltip>
  );
}
