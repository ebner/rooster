import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ViewTab } from '../shell/mobile-header';
import { type OrgViewId, paths } from '../shell/paths';
import { viewsFor } from '../shell/sidebar-views';

/**
 * The phone's view switcher (02 §13.1): My tasks · Today · 7 days · Overdue · No date ·
 * Everyone, in the sidebar's order; Everyone in shared orgs only (FR-COL-6). Labels are the
 * short phone ones (`mobile:views.tab.<id>`).
 */
export function useViewTabs(
  org: { isPersonal: boolean },
  orgSlug: string,
  active: OrgViewId,
): ViewTab[] {
  const { t } = useTranslation('mobile');
  const { isPersonal } = org;
  return useMemo(
    () =>
      viewsFor({ isPersonal }).map((view) => ({
        id: view.id,
        label: t(`views.tab.${view.id}`),
        href: paths.orgView(orgSlug, view.id),
        isActive: view.id === active,
      })),
    [t, orgSlug, active, isPersonal],
  );
}
