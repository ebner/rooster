import { BellPlus, BellRing } from 'lucide-react';
import { Focusable } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { Avatar } from '../../ui/avatar';
import { Button } from '../../ui/button';
import { Tooltip } from '../../ui/tooltip';

export interface FollowerPerson {
  id: string;
  name: string;
  image?: string | null | undefined;
}

export interface FollowerStackProps {
  followers: readonly FollowerPerson[];
  /** Avatars shown before "+N". */
  max?: number;
  className?: string | undefined;
}

/**
 * The task's followers (FR-COL-4, 02 §9.2 item 8): overlapping 20 px avatars, then "+N". The
 * names are in the tooltip and the accessible name.
 */
export function FollowerStack({ followers, max = 4, className }: FollowerStackProps) {
  const { t } = useTranslation('collab');
  if (followers.length === 0) return null;
  const shown = followers.slice(0, max);
  const rest = followers.length - shown.length;
  const names = followers.map((f) => f.name).join(', ');
  const label = t('followers.label', { count: followers.length, names });
  return (
    <Tooltip content={label}>
      {/* Named for screen readers; the tooltip repeats the names on hover. */}
      <Focusable excludeFromTabOrder>
        <span
          role="img"
          aria-label={label}
          data-testid="follower-stack"
          className={cn('inline-flex shrink-0 items-center', className)}
        >
          {shown.map((person, i) => (
            <Avatar
              key={person.id}
              id={person.id}
              name={person.name}
              src={person.image ?? undefined}
              size={20}
              decorative
              className={cn('ring-2 ring-bg-elevated', i > 0 && '-ms-1')}
            />
          ))}
          {rest > 0 && (
            <span className="-ms-1 inline-flex size-5 items-center justify-center rounded-full bg-bg-muted text-xs font-medium text-text-secondary ring-2 ring-bg-elevated tabular-nums">
              +{rest}
            </span>
          )}
        </span>
      </Focusable>
    </Tooltip>
  );
}

export interface FollowToggleProps {
  following: boolean;
  onToggle: (following: boolean) => void;
  size?: 'sm' | 'md';
  'data-force'?: string;
}

/** Follow / Following (FR-COL-4): unfollowing mutes the task's notifications. */
export function FollowToggle({ following, onToggle, size = 'sm', ...rest }: FollowToggleProps) {
  const { t } = useTranslation('collab');
  return (
    <Button
      size={size}
      variant="ghost"
      icon={following ? BellRing : BellPlus}
      aria-pressed={following}
      onPress={() => onToggle(!following)}
      data-testid="follow-toggle"
      {...rest}
    >
      {following ? t('followers.following') : t('followers.follow')}
    </Button>
  );
}
