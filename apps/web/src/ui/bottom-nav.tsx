import type { LucideIcon } from 'lucide-react';
import { Button as AriaButton, Link as AriaLink } from 'react-aria-components';
import { cn } from '../lib/cn';
import { iconStrokeWidth } from './button';

export interface BottomNavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  href?: string | undefined;
  onPress?: (() => void) | undefined;
  isActive?: boolean | undefined;
  isDisabled?: boolean | undefined;
  /** Unread count (the P6 Inbox tab). */
  badge?: number | undefined;
}

export interface BottomNavProps {
  /** The navigation landmark's name. */
  label: string;
  items: readonly BottomNavItem[];
  /** `toolbar`: the same bar holding actions (selection mode's bulk bar), not navigation. */
  kind?: 'nav' | 'toolbar';
  className?: string | undefined;
  'data-force'?: string;
}

const itemClass = cn(
  'relative flex min-w-0 flex-1 cursor-default flex-col items-center justify-center gap-0.5 text-xs font-medium',
  'text-text-secondary transition-colors duration-(--dur-fast) ease-standard',
  'pressed:bg-bg-subtle data-disabled:text-text-disabled',
  'outline-none focus-ring:outline-2 focus-ring:-outline-offset-4 focus-ring:outline-border-focus focus-ring:rounded-md',
);

/**
 * The phone's bottom navigation (02 §13.1): 64 px plus the safe area, icons with labels, the
 * active tab in the accent colour. P4 ships My tasks · Search · Settings; P6 adds Inbox.
 */
export function BottomNav({
  label,
  items,
  kind = 'nav',
  className,
  'data-force': force,
}: BottomNavProps) {
  const Root = kind === 'nav' ? 'nav' : 'div';
  return (
    <Root
      aria-label={label}
      {...(kind === 'toolbar' ? { role: 'toolbar' } : {})}
      className={cn(
        'flex h-bottom-nav-safe shrink-0 items-stretch border-t border-border bg-bg-elevated pb-safe ps-safe pe-safe',
        className,
      )}
    >
      {items.map((item) => {
        const Icon = item.icon;
        const content = (
          <>
            <span className="relative">
              <Icon
                className="size-6"
                strokeWidth={item.isActive ? 2.25 : iconStrokeWidth}
                aria-hidden
              />
              {item.badge !== undefined && item.badge > 0 && (
                <span className="absolute -end-2 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-bg-accent px-1 text-xs text-text-on-accent tabular-nums">
                  {item.badge}
                </span>
              )}
            </span>
            <span className="max-w-full truncate px-1">{item.label}</span>
          </>
        );
        // Accent text only passes contrast on white, so a pressed active tab darkens it.
        const className = cn(
          itemClass,
          item.isActive && 'text-text-accent pressed:text-text-accent-hover',
        );
        const forced = force && item.isActive ? { 'data-force': force } : {};
        return item.href ? (
          <AriaLink
            key={item.id}
            href={item.href}
            isDisabled={item.isDisabled ?? false}
            className={className}
            {...(item.isActive ? { 'aria-current': 'page' as const } : {})}
            {...forced}
          >
            {content}
          </AriaLink>
        ) : (
          <AriaButton
            key={item.id}
            isDisabled={item.isDisabled ?? false}
            {...(item.onPress ? { onPress: item.onPress } : {})}
            className={className}
            {...forced}
          >
            {content}
          </AriaButton>
        );
      })}
    </Root>
  );
}
