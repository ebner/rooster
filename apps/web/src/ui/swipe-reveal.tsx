import type { SwipeAction } from '@rooster/core/schemas';
import { Calendar, Check, FolderInput, type LucideIcon, Trash2 } from 'lucide-react';
import type { CSSProperties } from 'react';
import { cn } from '../lib/cn';
import { iconStrokeWidth } from './button';

export type SwipeRevealAction = Exclude<SwipeAction, 'none'>;

interface Look {
  icon: LucideIcon;
  surface: string;
  /** Label text (a contrast-tested pair with the surface). */
  ink: string;
  /** The icon may be lighter: non-text contrast only needs 3:1. */
  iconInk?: string;
}

const looks: Record<SwipeRevealAction, Look> = {
  // 03 §2.2: the swipe-complete reveal is green-50 with a green-600 icon.
  complete: {
    icon: Check,
    surface: 'bg-bg-success-subtle',
    ink: 'text-text-success',
    iconInk: 'text-check-done',
  },
  date: { icon: Calendar, surface: 'bg-bg-info-subtle', ink: 'text-text-info' },
  move: { icon: FolderInput, surface: 'bg-bg-muted', ink: 'text-text-secondary' },
  delete: { icon: Trash2, surface: 'bg-bg-danger-subtle', ink: 'text-text-danger' },
};

export interface SwipeRevealProps {
  action: SwipeRevealAction;
  /** `start`: revealed on the left by a swipe right; `end`: on the right by a swipe left. */
  side: 'start' | 'end';
  /** Past the commit threshold: the icon grows, telling the finger it may let go. */
  armed: boolean;
  label: string;
  className?: string | undefined;
  style?: CSSProperties | undefined;
}

/**
 * What a swiped row uncovers (02 §13.2): the action's tint, icon and label on the side the
 * row moves away from. Purely visual; the gesture announces the action itself.
 */
export function SwipeReveal({ action, side, armed, label, className, style }: SwipeRevealProps) {
  const look = looks[action];
  const Icon = look.icon;
  return (
    <div
      aria-hidden
      data-swipe-reveal={action}
      data-armed={armed || undefined}
      style={style}
      className={cn(
        'flex items-center gap-2 rounded-sm px-5 text-sm font-medium',
        side === 'start' ? 'justify-start' : 'flex-row-reverse justify-start',
        look.surface,
        look.ink,
        className,
      )}
    >
      <Icon
        className={cn(
          'size-5 shrink-0 transition-transform duration-(--dur-fast) ease-spring',
          look.iconInk,
          armed && 'scale-125',
        )}
        strokeWidth={armed ? 2.5 : iconStrokeWidth}
      />
      <span className="truncate">{label}</span>
    </div>
  );
}
