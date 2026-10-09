import { type ReactNode, useId } from 'react';
import { cn } from '../../lib/cn';

export interface SettingsSectionProps {
  id?: string;
  title: string;
  description?: ReactNode;
  /** Right-aligned header content, e.g. a primary action. */
  actions?: ReactNode;
  tone?: 'default' | 'danger';
  /**
   * The title names the whole page (Profile, Notifications): phones show it in the header
   * already, so here it is only for screen readers there.
   */
  isPageTitle?: boolean;
  children: ReactNode;
  className?: string | undefined;
}

/** A settings block: section title (03 §2.5 `text-lg`), muted lead, content. */
export function SettingsSection({
  id,
  title,
  description,
  actions,
  tone = 'default',
  isPageTitle = false,
  children,
  className,
}: SettingsSectionProps) {
  const titleId = useId();
  return (
    <section
      id={id}
      aria-labelledby={titleId}
      className={cn('flex scroll-mt-16 flex-col gap-4', className)}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h2
            id={titleId}
            className={cn(
              'text-lg',
              tone === 'danger' && 'text-text-danger',
              isPageTitle && 'max-tablet:sr-only',
            )}
          >
            {title}
          </h2>
          {description && <div className="text-sm text-text-secondary">{description}</div>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export interface FieldRowProps {
  label: ReactNode;
  children: ReactNode;
  /** Ties the visible label to a control that has no own label element. */
  labelId?: string;
}

/** A label/value row: label column on wide screens, stacked on phones (03 §3.11 grid). */
export function FieldRow({ label, children, labelId }: FieldRowProps) {
  return (
    <div className="flex flex-col gap-1.5 tablet:flex-row tablet:items-start tablet:gap-6">
      <div
        id={labelId}
        className="shrink-0 text-sm font-medium text-text-secondary tablet:flex tablet:min-h-control tablet:w-label-col tablet:items-center"
      >
        {label}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">{children}</div>
    </div>
  );
}
