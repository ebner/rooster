import { ChevronDown, Sprout } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ListGroup } from '../../data/types';
import { iconStrokeWidth } from '../../ui/button';

export interface MyTasksPlaceholderProps {
  groups: readonly ListGroup[];
}

/**
 * Phase 1 stand-in for My tasks: the user's group headers (03 §3.2 metrics) with a
 * ghost hint row in the first group, like the first-run hint (02 §14). The Inbox
 * is hidden while empty (02 §4).
 */
export function MyTasksPlaceholder({ groups }: MyTasksPlaceholderProps) {
  const { t } = useTranslation('shell');
  const visible = groups.filter((group) => group.kind !== 'inbox');
  return (
    <div className="flex flex-col">
      {visible.map((group, index) => (
        <section key={group.id} aria-label={group.name} className="mt-6 first:mt-0">
          <h2 className="flex h-group items-center gap-2 text-group">
            <ChevronDown
              className="size-4 shrink-0 text-text-muted"
              strokeWidth={iconStrokeWidth}
              aria-hidden
            />
            {group.name}
          </h2>
          {index === 0 && (
            <p className="flex min-h-row items-center gap-2 py-2 ps-6 text-base text-text-muted">
              <Sprout className="size-4 shrink-0" strokeWidth={iconStrokeWidth} aria-hidden />
              {t('placeholder.hint')}
            </p>
          )}
        </section>
      ))}
    </div>
  );
}
