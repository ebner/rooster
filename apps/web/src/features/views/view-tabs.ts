import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ViewTab } from '../shell/mobile-header';
import { type AllViewId, paths } from '../shell/paths';
import { viewsFor } from '../shell/sidebar-views';
import { type ListViewKey, savedViewIdOf } from './last-view';
import { useSavedViewsHook } from './view-counts';

/** A saved view's tab ID (never one of the built-in view IDs). */
export const savedViewTabId = (viewId: string) => `view-${viewId}`;

/**
 * The phone's view switcher (02 §13.1): My tasks · Today · 7 days · Overdue · No date ·
 * Everyone, in the sidebar's order; Everyone in shared orgs only (FR-COL-6). Labels are the
 * short phone ones (`mobile:views.tab.<id>`). Then the org's views (ADR 0073 B12), in the
 * member's own order, under their names. `active` may be a view's `v:<id>` key (`listViewOf`);
 * `activeSavedViewId` marks one explicitly.
 */
export function useViewTabs(
  org: { id: string; isPersonal: boolean },
  orgSlug: string,
  active: ListViewKey | null,
  activeSavedViewId: string | null = savedViewIdOf(active),
): ViewTab[] {
  const { t } = useTranslation('mobile');
  const { id: orgId, isPersonal } = org;
  const savedViews = useSavedViewsHook()(orgId).views;
  return useMemo(
    () => [
      ...viewsFor({ isPersonal }).map((view) => ({
        id: view.id,
        label: t(`views.tab.${view.id}`),
        href: paths.orgView(orgSlug, view.id),
        isActive: activeSavedViewId === null && view.id === active,
      })),
      ...(savedViews ?? []).map((view) => ({
        id: savedViewTabId(view.id),
        label: view.name,
        href: paths.savedView(orgSlug, view.id),
        isActive: view.id === activeSavedViewId,
      })),
    ],
    [t, orgSlug, active, activeSavedViewId, isPersonal, savedViews],
  );
}

const allTabs: readonly AllViewId[] = ['today', 'week', 'overdue'];

/** Phase 13 (02 §13.1): All organisations' view switcher, Today · 7 days · Overdue. */
export function useAllViewTabs(active: AllViewId | null): ViewTab[] {
  const { t } = useTranslation('mobile');
  return useMemo(
    () =>
      allTabs.map((id) => ({
        id,
        label: t(`views.tab.${id}`),
        href: paths.allView(id),
        isActive: id === active,
      })),
    [t, active],
  );
}
