import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button as AriaButton, Link as AriaLink } from 'react-aria-components';
import { cn } from '../../lib/cn';
import { iconStrokeWidth } from '../../ui/button';
import { Kbd } from '../../ui/kbd';
import { Tooltip } from '../../ui/tooltip';

/** 03 §3.10: 32 px, radius sm, 8 px padding, 20 px icon, sm label, count right-aligned. */
export const sidebarItemClass = cn(
  'group/item flex h-control w-full min-w-0 cursor-default items-center gap-2 rounded-sm px-2 text-sm text-text-secondary',
  'pointer-coarse:h-hit-touch',
  'transition-colors duration-(--dur-fast) ease-standard',
  'hover:bg-bg-muted hover:text-text pressed:bg-bg-muted',
  'data-disabled:cursor-not-allowed data-disabled:text-text-disabled data-disabled:hover:bg-transparent',
  'outline-offset-0 focus-ring:outline-2 focus-ring:outline-border-focus',
);

export const sidebarItemActiveClass = 'bg-bg-muted font-medium text-text';

export interface SidebarItemProps {
  icon?: LucideIcon;
  /** Replaces the icon slot, e.g. with an avatar (keep it 20 px wide). */
  leading?: ReactNode;
  label: string;
  href?: string;
  onPress?: () => void;
  count?: number | undefined;
  /** Rose count (Overdue, 03 §3.10). */
  countTone?: 'default' | 'danger';
  shortcut?: string | undefined;
  isActive?: boolean;
  isDisabled?: boolean;
  /** Icon-only rail rendering; the label moves into a tooltip. */
  rail?: boolean;
  /** Extra tooltip context in the rail, e.g. the org name. */
  railHint?: string | undefined;
  'data-force'?: string;
}

/** A sidebar navigation row: a link when it has `href`, otherwise a button. */
export function SidebarItem({
  icon: Icon,
  leading,
  label,
  href,
  onPress,
  count,
  countTone = 'default',
  shortcut,
  isActive = false,
  isDisabled = false,
  rail = false,
  railHint,
  'data-force': force,
}: SidebarItemProps) {
  const className = cn(
    sidebarItemClass,
    isActive && sidebarItemActiveClass,
    rail && 'justify-center px-0',
  );
  const content = (
    <>
      {leading ??
        (Icon && <Icon className="size-5 shrink-0" strokeWidth={iconStrokeWidth} aria-hidden />)}
      {!rail && <span className="min-w-0 flex-1 truncate text-start">{label}</span>}
      {!rail && count !== undefined && count > 0 && (
        <span
          className={cn(
            'shrink-0 text-xs tabular-nums',
            countTone === 'danger' ? 'font-medium text-text-danger' : 'text-text-secondary',
          )}
        >
          {count}
        </span>
      )}
      {!rail && shortcut && <Kbd shortcut={shortcut} className="shrink-0" />}
    </>
  );
  const common = {
    className,
    ...(force ? { 'data-force': force } : {}),
    ...(rail ? { 'aria-label': railHint ? `${label} · ${railHint}` : label } : {}),
  };
  const element = href ? (
    <AriaLink
      href={href}
      isDisabled={isDisabled}
      {...(isActive ? { 'aria-current': 'page' as const } : {})}
      {...common}
    >
      {content}
    </AriaLink>
  ) : (
    <AriaButton isDisabled={isDisabled} {...(onPress ? { onPress } : {})} {...common}>
      {content}
    </AriaButton>
  );
  if (!rail || isDisabled) return element;
  return (
    <Tooltip
      content={railHint ? `${label} · ${railHint}` : label}
      shortcut={shortcut}
      placement="end"
    >
      {element}
    </Tooltip>
  );
}
