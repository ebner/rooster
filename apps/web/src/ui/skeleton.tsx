import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/cn';

export interface SkeletonProps {
  className?: string | undefined;
  style?: CSSProperties;
}

/** 03 §3.16: an n-100 block with a shimmer that stops under reduced motion. */
export function Skeleton({ className, style }: SkeletonProps) {
  return (
    <span
      aria-hidden
      className={cn('block rounded-xs skeleton-shimmer', className)}
      style={style}
    />
  );
}

/** Title widths between 40 % and 75 %, deterministic per row index (no layout jitter). */
export function skeletonTitleWidth(index: number): number {
  return 40 + ((index * 37 + 11) % 36);
}

export interface SkeletonRowsProps {
  count?: number;
  className?: string | undefined;
}

/** Placeholder task rows for a cold start (02 §14: 3 per group). */
export function SkeletonRows({ count = 3, className }: SkeletonRowsProps) {
  const { t } = useTranslation();
  return (
    <div role="status" aria-busy="true" className={cn('flex flex-col', className)}>
      <span className="sr-only">{t('list.loading')}</span>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex h-row items-center gap-2 px-3 max-tablet:h-row-mobile">
          <span className="w-4 shrink-0" />
          <Skeleton className="size-checkbox shrink-0 rounded-full" />
          <Skeleton className="h-3" style={{ width: `${skeletonTitleWidth(index)}%` }} />
          <Skeleton className="ms-auto h-3 w-10 shrink-0" />
        </div>
      ))}
    </div>
  );
}
