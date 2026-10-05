import { cva } from 'class-variance-authority';
import { CircleAlert, CircleCheck, Info, type LucideIcon, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { iconStrokeWidth } from './button';

export type BannerTone = 'info' | 'success' | 'warning' | 'danger';

const bannerVariants = cva('flex items-start gap-2 rounded-md px-3 py-2 text-start text-sm', {
  variants: {
    tone: {
      info: 'bg-bg-info-subtle text-text-info',
      success: 'bg-bg-success-subtle text-text-success',
      warning: 'bg-bg-warning-subtle text-text-warning',
      danger: 'bg-bg-danger-subtle text-text-danger',
    },
  },
  defaultVariants: { tone: 'info' },
});

const toneIcons: Record<BannerTone, LucideIcon> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleAlert,
};

export interface BannerProps {
  tone?: BannerTone;
  title?: ReactNode;
  children?: ReactNode;
  /** `alert` for errors that appear in response to an action; omit for static notes. */
  role?: 'alert' | 'status';
  className?: string | undefined;
}

/** An inline message: tinted background, tone icon and text (meaning is never colour-only). */
export function Banner({ tone = 'info', title, children, role, className }: BannerProps) {
  const Icon = toneIcons[tone];
  return (
    <div role={role} className={cn(bannerVariants({ tone }), className)}>
      <Icon className="mt-0.5 size-4 shrink-0" strokeWidth={iconStrokeWidth} aria-hidden />
      <div className="flex min-w-0 flex-col gap-0.5">
        {title && <p className="font-medium">{title}</p>}
        {children && <div>{children}</div>}
      </div>
    </div>
  );
}
