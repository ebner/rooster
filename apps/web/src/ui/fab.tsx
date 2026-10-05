import { type LucideIcon, Plus } from 'lucide-react';
import { Button as AriaButton, type ButtonProps as AriaButtonProps } from 'react-aria-components';
import { cn } from '../lib/cn';
import { iconStrokeWidth } from './button';

export interface FabProps extends Omit<AriaButtonProps, 'className' | 'children' | 'aria-label'> {
  'aria-label': string;
  icon?: LucideIcon;
  /** Hidden (and inert) while the keyboard is open or a sheet covers the list. */
  isHidden?: boolean;
  /** Kitchen sink: in the page flow instead of fixed above the bottom nav. */
  isStatic?: boolean;
  className?: string | undefined;
  'data-force'?: string;
}

/**
 * The floating action button (02 §13.1): a 56 px coral circle with "+", 16 px above the bottom
 * nav at the right edge (and above stacked toasts). It slides away while hidden.
 */
export function Fab({
  icon: Icon = Plus,
  isHidden = false,
  isStatic = false,
  className,
  ...props
}: FabProps) {
  return (
    <AriaButton
      {...props}
      {...(isHidden ? { 'aria-hidden': true, excludeFromTabOrder: true } : {})}
      data-fab
      className={cn(
        'inline-flex size-fab cursor-default items-center justify-center rounded-full bg-brand text-text-on-accent shadow-lg',
        'transition-[transform,opacity,background-color,bottom] duration-(--dur-base) ease-standard',
        'hover:bg-bg-accent pressed:scale-95 pressed:bg-bg-accent-hover',
        'outline-offset-2 focus-ring:outline-2 focus-ring:outline-border-focus',
        !isStatic && 'fixed end-4 bottom-fab z-(--z-sticky)',
        isHidden && 'pointer-events-none translate-y-4 opacity-0',
        className,
      )}
    >
      <Icon className="size-6" strokeWidth={iconStrokeWidth} aria-hidden />
    </AriaButton>
  );
}
