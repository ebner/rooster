import { LayoutGrid } from 'lucide-react';
import { cn } from '../../lib/cn';
import { iconStrokeWidth } from '../../ui/button';

const sizeClasses = {
  16: { tile: 'size-4', icon: 'size-3' },
  20: { tile: 'size-5', icon: 'size-3' },
  24: { tile: 'size-6', icon: 'size-4' },
} as const;

/**
 * All organisations where an org shows its avatar (the sidebar heading, the rail, the phone's
 * org switcher and sheet; ADR 0073 A): a neutral square of the org avatar's size and radius,
 * so it lines up with the orgs below it without taking an org colour. Always decorative: the
 * name is shown or spoken next to it.
 */
export function AllOrgsMark({
  size = 24,
  className,
}: {
  size?: keyof typeof sizeClasses;
  className?: string | undefined;
}) {
  const classes = sizeClasses[size];
  return (
    <span
      aria-hidden
      data-testid="all-orgs-mark"
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-xs bg-bg-muted text-text-secondary',
        classes.tile,
        className,
      )}
    >
      <LayoutGrid className={classes.icon} strokeWidth={iconStrokeWidth} />
    </span>
  );
}
