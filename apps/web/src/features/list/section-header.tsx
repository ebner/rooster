import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import type { Translate } from './controller';
import { GridCell, GridRow } from './grid';
import { useListContext } from './list-context';
import type { SectionRow } from './model/rows';
import { sectionLabel } from './section-label';

export interface SectionHeaderViewProps {
  row: SectionRow;
}

/**
 * A smart-view section header (02 §10): a group header's look (03 §3.2: 44 px, `text-group`,
 * sticky, the open count after the name) without the chevron, rename, "+" or "⋯": sections
 * are derived from due dates, so they are neither editable nor draggable. Overdue's name is
 * in the overdue date colour.
 */
export const SectionHeader = memo(function SectionHeader({ row }: SectionHeaderViewProps) {
  const { t } = useTranslation('views');
  const { t: tList } = useTranslation('list');
  const { dateCtx } = useListContext();
  const label = sectionLabel(t as unknown as Translate, row.sectionKind, row.date, dateCtx);
  return (
    <GridRow
      aria-level={1}
      data-row-id={row.id}
      data-testid="section-header"
      data-section={row.sectionKind}
      className={cn(
        'sticky top-(--list-sticky-top) z-(--z-sticky) shrink-0 bg-bg-app',
        !row.first && 'mt-6',
      )}
    >
      <GridCell className="flex h-group items-center gap-1 ps-1 pe-1 max-tablet:h-group-mobile">
        <span aria-hidden className="size-6 shrink-0" />
        <div className="flex min-w-0 flex-1 items-baseline gap-2 ps-1">
          <h2
            className={cn(
              'min-w-0 truncate text-group',
              row.sectionKind === 'overdue' && 'text-date-overdue',
            )}
          >
            {label}
          </h2>
          <span aria-hidden className="shrink-0 text-sm text-text-muted tabular-nums">
            {row.count}
          </span>
          <span className="sr-only">{tList('group.count', { count: row.count })}</span>
        </div>
      </GridCell>
    </GridRow>
  );
});
