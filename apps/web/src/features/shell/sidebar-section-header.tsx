import type { TagColor } from '@rooster/tokens';
import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { iconStrokeWidth } from '../../ui/button';

/**
 * The parts every sidebar section shares (All organisations and each org; ADR 0076), so the
 * column stays aligned: a header row as tall as the items, with an always-visible chevron at
 * the start, the 24 px avatar and the name in `text-sm` semibold; under it the items, indented
 * 12 px past a 1 px guide in the org's colour.
 */

/** The header's toggle: chevron, avatar and name. The row around it may add controls. */
export const sectionHeaderButtonClass = cn(
  'group/toggle flex h-control min-w-0 flex-1 cursor-default items-center gap-1 rounded-sm ps-1 pe-2 text-start text-sm font-semibold text-text',
  'pointer-coarse:h-hit-touch',
  // Inset, like the items': the column scrolls and would clip an outer ring.
  '-outline-offset-2 focus-ring:outline-2 focus-ring:outline-border-focus',
);

/**
 * The hairline between sections. The sidebar adds 12 px on either side (`gap-3`, `pt-3`), so a
 * header has about 24 px above it and 4 px (`gap-1`) to its items.
 */
export const sectionDividerClass = 'border-t border-border';

/** Points down when open and to the name's side when collapsed; muted, brighter on hover. */
export function SectionChevron({ collapsed }: { collapsed: boolean }) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      <ChevronDown
        className={cn(
          'size-4 text-icon-subtle transition duration-(--dur-fast) ease-standard',
          'group-hover/toggle:text-text-secondary',
          collapsed && '-rotate-90',
        )}
        strokeWidth={iconStrokeWidth}
        aria-hidden
      />
    </span>
  );
}

/**
 * The guide's colour per org colour: the tag palette's text colour, faint, so it reads as the
 * org's without competing with the items. Static strings, for Tailwind to find.
 */
const guideClasses: Record<TagColor, string> = {
  gray: 'border-tag-gray-fg/40',
  red: 'border-tag-red-fg/40',
  orange: 'border-tag-orange-fg/40',
  amber: 'border-tag-amber-fg/40',
  green: 'border-tag-green-fg/40',
  teal: 'border-tag-teal-fg/40',
  blue: 'border-tag-blue-fg/40',
  indigo: 'border-tag-indigo-fg/40',
  purple: 'border-tag-purple-fg/40',
  pink: 'border-tag-pink-fg/40',
};

export function sectionGuideClass(color: TagColor | null | undefined): string {
  return color ? guideClasses[color] : 'border-border';
}

export interface SectionItemsProps {
  id?: string | undefined;
  hidden?: boolean | undefined;
  color?: TagColor | null | undefined;
  children: ReactNode;
}

/**
 * The section's items under its header: the guide runs under the chevron's middle, and the
 * items' icons line up under the avatar.
 */
export function SectionItems({ id, hidden, color, children }: SectionItemsProps) {
  return (
    <div
      id={id}
      hidden={hidden}
      data-section-items
      className={cn('ms-3 flex flex-col gap-0.5 border-s ps-1.5', sectionGuideClass(color))}
    >
      {children}
    </div>
  );
}
