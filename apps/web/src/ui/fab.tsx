import { type LucideIcon, Plus } from 'lucide-react';
import { useEffect, useRef } from 'react';
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
 * The floating action button (02 §13.1): a 56 px accent (amber) circle with "+", 16 px above the bottom
 * nav at the right edge (and above stacked toasts). It slides away while hidden.
 */
export function Fab({
  icon: Icon = Plus,
  isHidden = false,
  isStatic = false,
  className,
  ...props
}: FabProps) {
  const ref = useRef<HTMLButtonElement>(null);
  // Rise above stacked toasts instead of hiding behind them (02 §13.1). The FAB watches the
  // toast region itself, so a toast shown before the FAB mounted (e.g. the update prompt at
  // start-up) is respected too. The offset lives on the FAB: a :root property would restyle the
  // whole document on every toast (AC-2.12).
  useEffect(() => {
    const fab = ref.current;
    const region = document.querySelector<HTMLElement>('[data-toast-region]');
    if (isStatic || !fab || !region || typeof ResizeObserver === 'undefined') return;
    let last = -1;
    const apply = () => {
      // The region is display:none (0 px) when it holds no toasts.
      const height = Math.round(region.getBoundingClientRect().height);
      if (height === last) return;
      last = height;
      fab.style.setProperty('--toast-stack-height', `${height}px`);
    };
    const observer = new ResizeObserver(apply);
    observer.observe(region);
    apply();
    return () => observer.disconnect();
  }, [isStatic]);
  return (
    <AriaButton
      {...props}
      ref={ref}
      {...(isHidden ? { 'aria-hidden': true, excludeFromTabOrder: true } : {})}
      data-fab
      className={cn(
        'inline-flex size-fab cursor-default items-center justify-center rounded-full bg-bg-accent text-text-on-accent shadow-lg',
        'transition-[transform,opacity,background-color,bottom] duration-(--dur-base) ease-standard',
        'hover:bg-bg-accent-hover pressed:scale-95 pressed:bg-bg-accent-hover',
        'outline-offset-2 focus-ring:outline-2 focus-ring:outline-border-focus',
        !isStatic && 'fixed end-4 bottom-above-nav z-(--z-sticky)',
        isHidden && 'pointer-events-none translate-y-4 opacity-0',
        className,
      )}
    >
      <Icon className="size-6" strokeWidth={iconStrokeWidth} aria-hidden />
    </AriaButton>
  );
}
