import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button as AriaButton, Link as AriaLink, type PressEvent } from 'react-aria-components';
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
  // Inset, like a TaskRow's (03 §3.12): the items are stacked in a scroll container, which
  // would clip an outer ring at its edges.
  '-outline-offset-2 focus-ring:outline-2 focus-ring:outline-border-focus',
);

export const sidebarItemActiveClass = 'bg-bg-muted font-medium text-text';

export interface SidebarItemProps {
  icon?: LucideIcon;
  /** Replaces the icon slot, e.g. with an avatar (keep it 20 px wide). */
  leading?: ReactNode;
  label: string;
  href?: string;
  onPress?: (event: PressEvent) => void;
  count?: number | undefined;
  /** Spoken instead of the bare number (e.g. "3 unread"); the rail shows a dot for it. */
  countLabel?: string | undefined;
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
  'data-testid'?: string;
}

/** A sidebar navigation row: a link when it has `href`, otherwise a button. */
export function SidebarItem({
  icon: Icon,
  leading,
  label,
  href,
  onPress,
  count,
  countLabel,
  countTone = 'default',
  shortcut,
  isActive = false,
  isDisabled = false,
  rail = false,
  railHint,
  'data-force': force,
  'data-testid': testId,
}: SidebarItemProps) {
  const className = cn(
    sidebarItemClass,
    isActive && sidebarItemActiveClass,
    rail && 'justify-center px-0',
  );
  const counted = count !== undefined && count > 0;
  const icon =
    leading ??
    (Icon && <Icon className="size-5 shrink-0" strokeWidth={iconStrokeWidth} aria-hidden />);
  const content = (
    <>
      {rail && counted && countLabel ? (
        <span className="relative inline-flex shrink-0">
          {icon}
          <span
            aria-hidden
            data-testid="sidebar-dot"
            className="absolute -end-0.5 -top-0.5 size-2 rounded-full bg-bg-accent ring-2 ring-bg-sidebar"
          />
        </span>
      ) : (
        icon
      )}
      {!rail && <span className="min-w-0 flex-1 truncate text-start">{label}</span>}
      {!rail && counted && (
        <span
          className={cn(
            'shrink-0 text-xs tabular-nums',
            countTone === 'danger' ? 'font-medium text-text-danger' : 'text-text-secondary',
          )}
        >
          <span aria-hidden={countLabel ? true : undefined}>{count}</span>
          {countLabel && <span className="sr-only">{countLabel}</span>}
        </span>
      )}
      {!rail && shortcut && <Kbd shortcut={shortcut} className="shrink-0" />}
    </>
  );
  const railName = [label, railHint, counted ? countLabel : undefined].filter(Boolean).join(' · ');
  const common = {
    className,
    ...(force ? { 'data-force': force } : {}),
    ...(testId ? { 'data-testid': testId } : {}),
    ...(rail ? { 'aria-label': railName } : {}),
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
    <Tooltip content={railName} shortcut={shortcut} placement="end">
      {element}
    </Tooltip>
  );
}
