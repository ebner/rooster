import { useTranslation } from 'react-i18next';
import { type AllCounts, useAllViewCounts } from '../views/view-counts';
import { AllOrgsMark } from './all-orgs-mark';
import { type AllViewId, paths } from './paths';
import { SidebarItem } from './sidebar-item';
import { allSidebarViews, type SidebarViewDefinition } from './sidebar-views';

export interface SidebarAllSectionProps {
  /** The All view shown (or under the pane), else null. */
  activeView: AllViewId | null;
  /** Fixed badges (kitchen sink, tests); otherwise live, summed over every org's list. */
  counts?: AllCounts | undefined;
  rail?: boolean;
}

/**
 * "All organisations" above the org sections (02 §2, ADR 0073 A1, A5): Today, Next 7 days and
 * Overdue across every org, with the per-org icons and summed badges (Today; Overdue in danger
 * and only when > 0; none for Next 7 days). Not draggable or collapsible: it is no org.
 */
export function SidebarAllSection({ activeView, counts, rail = false }: SidebarAllSectionProps) {
  const { t } = useTranslation('shell');
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
        className="flex flex-col items-center gap-0.5"
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
    <section aria-label={title} data-testid="sidebar-all-orgs" className="flex flex-col gap-0.5">
      {/*
       * The org headers' metrics (avatar column, xs semibold muted) without their controls. Not
       * a heading: the org sections have none either, and the page's h1 comes after the nav.
       */}
      <div
        aria-hidden
        className="flex h-control-sm min-w-0 items-center gap-2 px-2 text-xs font-semibold text-text-muted"
      >
        <span className="flex w-5 shrink-0 justify-center">
          <AllOrgsMark size={16} />
        </span>
        <span className="min-w-0 truncate">{title}</span>
      </div>
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
    </section>
  );
}
