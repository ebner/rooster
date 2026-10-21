import { cva, type VariantProps } from 'class-variance-authority';
import { LoaderCircle, type LucideIcon } from 'lucide-react';
import { type ReactNode, type Ref, useEffect, useId, useRef } from 'react';
import { Button as AriaButton, type ButtonProps as AriaButtonProps } from 'react-aria-components';
import { cn } from '../lib/cn';

/**
 * 03 §3.5. Shared by Button and IconButton. On coarse pointers the hit area grows
 * to 44 px through a transparent ::after, so the visual size (and layout) stays put.
 */
export const buttonVariants = cva(
  [
    'relative inline-flex shrink-0 cursor-default items-center justify-center gap-1.5 whitespace-nowrap select-none',
    'font-medium transition-colors duration-(--dur-fast) ease-standard',
    'disabled:cursor-not-allowed',
    'pointer-coarse:after:absolute pointer-coarse:after:top-1/2 pointer-coarse:after:left-1/2',
    'pointer-coarse:after:min-h-hit-touch pointer-coarse:after:min-w-hit-touch',
    'pointer-coarse:after:size-full pointer-coarse:after:-translate-1/2',
  ],
  {
    variants: {
      variant: {
        primary:
          'rounded-sm bg-bg-accent text-text-on-accent hover:bg-bg-accent-hover pressed:bg-bg-accent-hover disabled:bg-bg-muted disabled:text-text-disabled',
        secondary:
          'rounded-sm border border-border bg-bg-elevated text-text hover:bg-bg-subtle pressed:bg-bg-muted disabled:bg-bg-subtle disabled:text-text-disabled',
        ghost:
          'rounded-sm bg-transparent text-text-secondary hover:bg-bg-subtle hover:text-text pressed:bg-bg-muted disabled:bg-transparent disabled:text-text-disabled',
        'ghost-inverse':
          'rounded-sm bg-transparent text-text-inverse-muted hover:bg-bg-inverse-muted hover:text-text-inverse pressed:bg-bg-inverse-muted disabled:text-text-disabled',
        danger:
          'rounded-sm bg-bg-danger text-text-on-danger hover:bg-bg-danger-hover pressed:bg-bg-danger-hover disabled:bg-bg-muted disabled:text-text-disabled',
        link: 'rounded-xs text-text-accent underline-offset-2 hover:text-text-accent-hover hover:underline pressed:text-text-accent-hover disabled:text-text-disabled disabled:no-underline',
      },
      size: {
        sm: 'h-control-sm px-2 text-sm',
        md: 'h-control px-3 text-sm',
        lg: 'h-control-lg px-4 text-base',
      },
    },
    compoundVariants: [{ variant: 'link', size: ['sm', 'md', 'lg'], className: 'h-auto px-0' }],
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>['variant']>;
export type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>['size']>;

export interface ButtonProps extends Omit<AriaButtonProps, 'className' | 'children' | 'isPending'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, keeps the width, and blocks presses (announced by React Aria). */
  isLoading?: boolean;
  /** Leading Lucide icon, rendered at 16 px with the Coop stroke width. */
  icon?: LucideIcon;
  className?: string | undefined;
  children?: ReactNode;
  /** Kitchen-sink only: render a state statically ("hover", "focus", "pressed"). */
  'data-force'?: string;
  /** Anchor for popovers (e.g. the bulk bar's date picker). */
  ref?: Ref<HTMLButtonElement> | undefined;
}

export function Button({
  variant,
  size,
  isLoading = false,
  icon: Icon,
  className,
  children,
  ...props
}: ButtonProps) {
  const fallbackId = useId();
  const id = props.id ?? fallbackId;
  const everLoading = useRef(false);
  if (isLoading) everLoading.current = true;
  // React Aria announces a focused button's pending state through a live-region node labelled
  // by the button's id, kept for seconds. A button that goes away while pending (a form that
  // closes on success) leaves that node pointing at nothing, an unnamed role="img": remove it.
  useEffect(
    () => () => {
      if (!everLoading.current) return;
      dropPendingAnnouncements(id);
      // The page's first announcement is added 100 ms late (React Aria waits for the region).
      setTimeout(() => dropPendingAnnouncements(id), announceDelayMs);
    },
    [id],
  );
  return (
    <AriaButton
      {...props}
      id={id}
      isPending={isLoading}
      className={cn(buttonVariants({ variant, size }), className)}
    >
      {isLoading && <Spinner />}
      <span className={cn('inline-flex items-center gap-1.5', isLoading && 'opacity-0')}>
        {Icon && <Icon className="size-4" strokeWidth={iconStrokeWidth} aria-hidden />}
        {children}
      </span>
    </AriaButton>
  );
}

/** Longer than React Aria's delay before the first announcement of a page. */
const announceDelayMs = 250;

/** Removes React Aria's live-region announcements that are labelled by the button `id`. */
function dropPendingAnnouncements(id: string): void {
  if (typeof document === 'undefined') return;
  for (const node of document.querySelectorAll('[data-live-announcer] [aria-labelledby]')) {
    if (node.getAttribute('aria-labelledby')?.split(' ').includes(id)) node.remove();
  }
}

/** Lucide stroke width for every Coop icon (03 §2.9). */
export const iconStrokeWidth = 1.75;

/** Centred spinner overlay; the label underneath keeps the button's width. */
export function Spinner() {
  return (
    <span className="absolute inset-0 inline-flex items-center justify-center" aria-hidden>
      <LoaderCircle className="size-4 motion-safe:animate-spin" strokeWidth={iconStrokeWidth} />
    </span>
  );
}
