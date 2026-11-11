import { ChevronRight, Repeat } from 'lucide-react';
import { type MouseEvent, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { useListUi } from '../../state/list-store';
import { iconStrokeWidth } from '../../ui/button';
import { IconButton } from '../../ui/icon-button';
import { GridCell, GridRow } from './grid';
import { useListContext } from './list-context';
import type { UpcomingRow } from './model/rows';

export interface UpcomingHeaderProps {
  row: UpcomingRow;
}

/**
 * The Upcoming section's header (ADR 0068), after the groups: a group header's look (chevron,
 * name, open count; sticky) with an icon and a hint, like the Inbox, since it is a system
 * section: no rename, "+" or "⋯", no drag, no drop target. A click anywhere on it, or ←/→
 * with it selected, folds or opens it.
 */
export const UpcomingHeader = memo(function UpcomingHeader({ row }: UpcomingHeaderProps) {
  const { t } = useTranslation('list');
  const { controller } = useListContext();
  const { id, count, collapsed } = row;
  const selected = useListUi((s) => Boolean(s.selected[id]));
  const name = t('upcoming.name');
  const hint = t('upcoming.hint');
  const tasks = t('a11y.groupCount', { count });
  const state = t(collapsed ? 'a11y.collapsed' : 'a11y.expanded');

  const onRowClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.target as Node)) return;
    if ((event.target as Element).closest('button')) return;
    controller.ui().select(id);
    controller.setUpcomingCollapsed(!collapsed);
  };

  return (
    <GridRow
      aria-level={1}
      aria-label={`${name}, ${tasks}`}
      aria-expanded={!collapsed}
      aria-selected={selected}
      data-row-id={id}
      data-testid="upcoming-header"
      onClick={onRowClick}
      onFocus={(event) => {
        // Tabbing onto the name selects the header in Navigate, as on a group.
        if (!(event.target as Element).matches('[data-focus-target]')) return;
        const store = controller.ui();
        if (store.cursor !== id && store.mode === 'navigate') store.select(id);
      }}
      className="sticky top-(--list-sticky-top) z-(--z-sticky) mt-6 shrink-0 bg-bg-app"
    >
      <GridCell
        className={cn(
          'relative flex h-group cursor-default items-center gap-1 rounded-sm ps-1 pe-1 max-tablet:h-group-mobile',
          selected ? 'bg-bg-selected' : 'hover:bg-bg-subtle',
          'has-[[data-focus-target]:focus-visible]:outline-2 has-[[data-focus-target]:focus-visible]:-outline-offset-2 has-[[data-focus-target]:focus-visible]:outline-border-focus',
        )}
      >
        {selected && (
          <span
            aria-hidden
            className="absolute inset-y-1 start-0 w-0.5 rounded-full bg-selection-bar"
          />
        )}
        <IconButton
          icon={ChevronRight}
          size="sm"
          aria-label={t(collapsed ? 'group.expand' : 'group.collapse', { name })}
          onPress={() => {
            controller.ui().select(id);
            controller.setUpcomingCollapsed(!collapsed);
          }}
          className={cn(
            'size-6 text-text-muted [&_svg]:transition-transform [&_svg]:duration-(--dur-fast)',
            !collapsed && '[&_svg]:rotate-90',
          )}
        />
        <Repeat
          className="size-4 shrink-0 text-text-muted"
          strokeWidth={iconStrokeWidth}
          aria-hidden
        />
        <div className="flex min-w-0 flex-1 items-baseline gap-2 ps-1">
          <h2
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a header is a tab stop (02 §6).
            tabIndex={0}
            data-focus-target
            aria-description={`${hint}, ${tasks}, ${state}`}
            className="min-w-0 truncate text-group outline-none"
          >
            {name}
          </h2>
          <span aria-hidden className="shrink-0 text-sm text-text-muted tabular-nums">
            {count}
          </span>
          <span className="sr-only">{t('group.count', { count })}</span>
          <span aria-hidden className="min-w-0 truncate text-sm text-text-muted max-tablet:hidden">
            {hint}
          </span>
        </div>
      </GridCell>
    </GridRow>
  );
});
