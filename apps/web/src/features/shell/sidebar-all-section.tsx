import { useId } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { type AllCounts, useAllViewCounts } from '../views/view-counts';
import { AllOrgsMark } from './all-orgs-mark';
import { type AllViewId, paths } from './paths';
import { SidebarItem } from './sidebar-item';
import {
  SectionChevron,
  SectionItems,
  sectionDividerClass,
  sectionHeaderButtonClass,
} from './sidebar-section-header';
import { allSidebarViews, type SidebarViewDefinition } from './sidebar-views';

export interface SidebarAllSectionProps {
  /** The All view shown (or under the pane), else null. */
  activeView: AllViewId | null;
  /** Fixed badges (kitchen sink, tests); otherwise live, summed over every org's list. */
  counts?: AllCounts | undefined;
  /** Collapsed on this browser (`allSectionCollapsed`); the rail ignores it. */
  collapsed?: boolean | undefined;
  onToggleCollapsed?: (() => void) | undefined;
  /** A hairline above the section (it is first in the sidebar, so normally none). */
  divider?: boolean;
  rail?: boolean;
}

/**
 * "All organisations" above the org sections (02 §2, ADR 0073 A1, A5): Today, Next 7 days and
 * Overdue across every org, with the per-org icons and summed badges (Today; Overdue in danger
 * and only when > 0; none for Next 7 days). Its header is styled like an org's, so the column
 * stays aligned, and collapses the same way (ADR 0076; on this browser only). Not draggable and
 * without a menu: it is no org.
 */
export function SidebarAllSection({
  activeView,
  counts,
  collapsed: collapsedProp = false,
  onToggleCollapsed,
  divider = false,
  rail = false,
}: SidebarAllSectionProps) {
  const { t } = useTranslation('shell');
  const listId = useId();
  const collapsed = collapsedProp && !rail;
  const live = useAllViewCounts();
  const shown = counts ?? live;
  const title = t('allOrgs.title');
  const badge = (view: SidebarViewDefinition & { id: AllViewId }) => ({
    count: view.badge ? shown?.[view.id] : undefined,
    countTone: view.badge === 'danger' ? ('danger' as const) : ('default' as const),
  });

  if (rail) {
    return (
      <section
        aria-label={title}
        data-testid="sidebar-all-orgs"
        className={cn('flex flex-col items-center gap-0.5', divider && sectionDividerClass)}
      >
        <span className="flex h-control-sm items-center" title={title}>
          <AllOrgsMark size={20} />
        </span>
        {allSidebarViews.map((view) => (
          <SidebarItem
            key={view.id}
            rail
            icon={view.icon}
            label={t(`view.${view.id}`)}
            railHint={title}
            href={paths.allView(view.id)}
            isActive={activeView === view.id}
            {...badge(view)}
          />
        ))}
      </section>
    );
  }

  return (
    <section
      aria-label={title}
      data-testid="sidebar-all-orgs"
      data-collapsed={collapsed ? '' : undefined}
      className={cn('flex flex-col gap-1', divider && sectionDividerClass)}
    >
      {/*
       * The org headers' toggle without their grip and menu. Not a heading: the org sections
       * have none either, and the page's h1 comes after the nav.
       */}
      <div className="flex h-control items-center pe-0.5 pointer-coarse:h-hit-touch">
        <AriaButton
          onPress={() => onToggleCollapsed?.()}
          aria-expanded={!collapsed}
          aria-controls={listId}
          className={sectionHeaderButtonClass}
        >
          <SectionChevron collapsed={collapsed} />
          <AllOrgsMark size={24} />
          <span className="ms-1 min-w-0 truncate">{title}</span>
        </AriaButton>
      </div>
      <SectionItems id={listId} hidden={collapsed}>
        <ul className="flex flex-col gap-0.5">
          {allSidebarViews.map((view) => (
            <li key={view.id}>
              <SidebarItem
                icon={view.icon}
                label={t(`view.${view.id}`)}
                href={paths.allView(view.id)}
                isActive={activeView === view.id}
                {...badge(view)}
              />
            </li>
          ))}
        </ul>
      </SectionItems>
    </section>
  );
}
