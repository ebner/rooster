import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      data-testid={`section-${id}`}
      className="flex scroll-mt-16 flex-col gap-6"
    >
      <h2 id={`${id}-title`} className="text-lg">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function Group({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-text-muted">{title}</h3>
      <div className={cn('flex flex-wrap items-start gap-x-6 gap-y-4', className)}>{children}</div>
    </div>
  );
}

export function Specimen({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <figure className={cn('flex flex-col items-start gap-2', className)}>
      <div className="flex min-h-control-lg items-center">{children}</div>
      <figcaption className="text-xs text-text-muted">{label}</figcaption>
    </figure>
  );
}
