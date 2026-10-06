import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ViewTab } from '../shell/mobile-header';
import { type OrgViewId, paths } from '../shell/paths';
import { sidebarViews } from '../shell/sidebar-views';

/**
 * The phone's view switcher (02 §13.1): My tasks · Today · 7 days · Overdue · No date, in the
 * sidebar's order. Labels are the short phone ones (`mobile:views.tab.<id>`).
 */
export function useViewTabs(orgSlug: string, active: OrgViewId): ViewTab[] {
  const { t } = useTranslation('mobile');
  return useMemo(
    () =>
      sidebarViews.map((view) => ({
        id: view.id,
        label: t(`views.tab.${view.id}`),
        href: paths.orgView(orgSlug, view.id),
        isActive: view.id === active,
      })),
    [t, orgSlug, active],
  );
}
