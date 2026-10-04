import type { ReactNode } from 'react';
import {
  Popover as AriaPopover,
  type PopoverProps as AriaPopoverProps,
  Dialog,
  DialogTrigger,
  type DialogTriggerProps,
} from 'react-aria-components';
import { cn } from '../lib/cn';

/**
 * 03 §3.8: elevated surface, hairline border, radius md, shadow md, 4 px padding.
 * Exported so static previews and other overlays (menus) share the exact styling.
 */
export const popoverSurface =
  'rounded-md border border-border bg-bg-elevated p-1 text-text shadow-md outline-none';

/** Enter: fade + 4 px slide from the anchor over 180 ms; fade only under reduced motion. */
export const popoverMotion = cn(
  'data-entering:animate-popover-in motion-reduce:data-entering:animate-fade-in',
  'data-[placement=top]:[--popover-enter-offset:var(--space-1)]',
);

/** Gap between anchor and overlay, matching spacing step 1. */
export const overlayOffsetPx = 4;

export interface PopoverProps extends Omit<AriaPopoverProps, 'className' | 'children'> {
  children: ReactNode;
  className?: string | undefined;
  /** Accessible name of the dialog inside the popover. */
  'aria-label'?: string;
}

/** An anchored, non-modal-feeling popover containing a dialog (02 §1: no modals). */
export function Popover({ children, className, 'aria-label': label, ...props }: PopoverProps) {
  return (
    <AriaPopover
      offset={overlayOffsetPx}
      {...props}
      className={cn(popoverSurface, popoverMotion, className)}
    >
      <Dialog {...(label ? { 'aria-label': label } : {})} className="outline-none">
        {children}
      </Dialog>
    </AriaPopover>
  );
}

export { DialogTrigger as PopoverTrigger, type DialogTriggerProps as PopoverTriggerProps };
