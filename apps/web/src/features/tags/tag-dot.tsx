import type { TagColor } from '@rooster/tokens';
import { cn } from '../../lib/cn';

/** Static classes so Tailwind sees every colour (03 §2.4: the chip's fg as the dot). */
const dotClasses: Record<TagColor, string> = {
  gray: 'bg-tag-gray-fg',
  red: 'bg-tag-red-fg',
  orange: 'bg-tag-orange-fg',
  amber: 'bg-tag-amber-fg',
  green: 'bg-tag-green-fg',
  teal: 'bg-tag-teal-fg',
  blue: 'bg-tag-blue-fg',
  indigo: 'bg-tag-indigo-fg',
  purple: 'bg-tag-purple-fg',
  pink: 'bg-tag-pink-fg',
};

/** The colour dot of a tag in pickers and settings. */
export function TagDot({ color, className }: { color: TagColor; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('size-2 shrink-0 rounded-full', dotClasses[color], className)}
    />
  );
}
