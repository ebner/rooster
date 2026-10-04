import { type TagColor, tagColorNames } from '@rooster/tokens';
import { useState } from 'react';
import { cn } from '../lib/cn';
import { tagColorClasses } from './chip';

export type AvatarSize = 16 | 20 | 24 | 32 | 40;

/** FNV-1a (32-bit): tiny, stable across platforms, good spread for UUIDs. */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 03 §3.13: the fallback colour is a tag-palette colour chosen by hashing the id. */
export function avatarColor(id: string): TagColor {
  return tagColorNames[hashString(id) % tagColorNames.length] ?? 'gray';
}

/** "Anna Lindqvist" → "AL", "sara" → "S"; small avatars show one letter. */
export function initials(name: string, max: 1 | 2 = 2): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0], words.at(-1)] : [words[0]];
  return letters
    .map((word) => (word ? Array.from(word)[0] : ''))
    .join('')
    .toLocaleUpperCase()
    .slice(0, max);
}

const sizeClasses: Record<AvatarSize, string> = {
  16: 'size-4 text-xs',
  20: 'size-5 text-xs',
  24: 'size-6 text-xs',
  32: 'size-8 text-xs',
  40: 'size-10 text-sm',
};

const shapeClasses = {
  circle: 'rounded-full',
  square: 'rounded-xs',
} as const;

export interface AvatarProps {
  /** Stable id (user or org UUID) used for the fallback colour. */
  id: string;
  /** Display name: the accessible name and the source of the initials. */
  name: string;
  src?: string | undefined;
  /** Org avatars may use an emoji instead of initials. */
  emoji?: string | undefined;
  size?: AvatarSize;
  /** `square` is the org variant (radius xs). */
  shape?: 'circle' | 'square';
  /** Decorative avatars (name shown next to them) hide from assistive tech. */
  decorative?: boolean;
  className?: string | undefined;
}

export function Avatar({
  id,
  name,
  src,
  emoji,
  size = 24,
  shape = 'circle',
  decorative = false,
  className,
}: AvatarProps) {
  const [failedSrc, setFailedSrc] = useState<string | undefined>();
  const showImage = src !== undefined && src !== failedSrc;
  const a11y = decorative ? { 'aria-hidden': true as const } : { role: 'img', 'aria-label': name };
  const classes = cn(
    'inline-flex shrink-0 select-none items-center justify-center overflow-hidden font-semibold leading-none',
    sizeClasses[size],
    shapeClasses[shape],
    className,
  );

  if (showImage) {
    return (
      <img
        src={src}
        alt={decorative ? '' : name}
        onError={() => setFailedSrc(src)}
        className={cn(classes, 'object-cover')}
        draggable={false}
      />
    );
  }
  return (
    <span
      {...a11y}
      data-color={avatarColor(id)}
      className={cn(classes, tagColorClasses[avatarColor(id)])}
    >
      <span aria-hidden>{emoji ?? initials(name, size <= 20 ? 1 : 2)}</span>
    </span>
  );
}
