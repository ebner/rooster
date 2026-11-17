import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import type { SavedView, SavedViewMove } from '@rooster/core/schemas';
import { type ReactNode, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Org } from '../../data/types';
import { Group } from '../dev-ui/layout';
import { ViewsSection } from '../org-settings/views-section';
import { FixedSavedViews } from '../views/view-counts';
import { useViewTabs } from '../views/view-tabs';
import { fixtureIds, fixtureMe } from './fixtures';
import { ViewSwitcher } from './mobile-header';
import { orgUrlSlug } from './paths';
import { SidebarOrgSection } from './sidebar-org-section';
import { SidebarSavedViews } from './sidebar-saved-views';

const company = fixtureMe.orgs[1] as Org;
const tagJuniper = '0192f5d0-7a1e-7c3a-9f10-0000000000f1';
const tagLaunch = '0192f5d0-7a1e-7c3a-9f10-0000000000f2';

/** A sample view of Northwind (stable IDs; `n` orders them). */
export function sampleSavedView(
  n: number,
  name: string,
  overrides: Partial<SavedView> & { tags?: string[] } = {},
): SavedView {
  const { tags = [], ...rest } = overrides;
  return {
    id: `0192f5d0-7a1e-7c3a-9f10-0000000c000${n}`,
    orgId: fixtureIds.companyOrg,
    createdBy: fixtureIds.jannik,
    shared: true,
    name,
    query: { tags, tagMode: 'any', assignee: 'anyone', due: 'any', status: 'open' },
    archivedAt: null,
    position: `a${n}`,
    openCount: 0,
    createdAt: 0,
    updatedAt: 0,
    ...rest,
  };
}

function useSampleViews() {
  const { t } = useTranslation('shell');
  return useMemo(
    () => ({
      live: [
        sampleSavedView(1, t('savedViews.dev.names.juniper'), { tags: [tagJuniper], openCount: 7 }),
        sampleSavedView(2, t('savedViews.dev.names.mine'), {
          shared: false,
          openCount: 3,
          query: { tags: [], tagMode: 'any', assignee: 'me', due: 'week', status: 'open' },
        }),
        sampleSavedView(3, t('savedViews.dev.names.launch'), { tags: [tagLaunch], openCount: 0 }),
        sampleSavedView(4, t('savedViews.dev.names.unassigned'), {
          openCount: 12,
          query: { tags: [], tagMode: 'any', assignee: 'unassigned', due: 'any', status: 'open' },
        }),
      ],
      archived: [
        sampleSavedView(5, t('savedViews.dev.names.old'), {
          tags: [tagLaunch],
          archivedAt: 1,
          openCount: 1,
        }),
      ],
    }),
    [t],
  );
}

/** Applies a sidebar move to a local list (the kitchen sink has no server). */
function moved(views: readonly SavedView[], id: string, intent: SavedViewMove): SavedView[] {
  const view = views.find((v) => v.id === id);
  if (!view) return [...views];
  const rest = views.filter((v) => v.id !== id);
  const at = intent.afterId
    ? rest.findIndex((v) => v.id === intent.afterId) + 1
    : intent.beforeId
      ? rest.findIndex((v) => v.id === intent.beforeId)
      : rest.length;
  rest.splice(at, 0, view);
  return rest;
}

function Figure({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <figure className="flex flex-col gap-2">
      {children}
      <figcaption className="text-xs text-text-muted">{caption}</figcaption>
    </figure>
  );
}

/**
 * Phase 13 (ADR 0073 B): the sidebar's views (project `#` and plain ⌕ icons, counts, the active
 * one, a live reorder, a lifted one, an org without views, "New view" open, the rail), the
 * phone's switcher with views, and Org settings → Views.
 */
export function SavedViewsKitchenSpecimens() {
  const { t } = useTranslation('shell');
  const sample = useSampleViews();
  const [live, setLive] = useState<readonly SavedView[]>(sample.live);
  const [archived, setArchived] = useState<readonly SavedView[]>(sample.archived);
  const slug = orgUrlSlug(company);
  const first = live[0]?.id ?? null;
  return (
    <>
      <Group title={t('savedViews.dev.sidebar')}>
        <Figure caption={company.name}>
          <div className="w-sidebar rounded-md bg-bg-sidebar p-3">
            <DndContext>
              <SortableContext items={[company.id]}>
                <SidebarOrgSection
                  org={company}
                  activeView={null}
                  activeSavedViewId={first}
                  savedViews={live}
                  onMoveSavedView={(id, intent) => setLive((views) => moved(views, id, intent))}
                  counts={{ my: 7, today: 2, overdue: 1 }}
                  canMoveUp={false}
                  canMoveDown={false}
                  onMove={() => {}}
                  onToggleCollapsed={() => {}}
                />
              </SortableContext>
            </DndContext>
          </div>
        </Figure>
        <Figure caption={t('savedViews.dev.dragging')}>
          <div className="w-sidebar rounded-md bg-bg-sidebar p-3">
            <SidebarSavedViews
              orgName={company.name}
              slug={slug}
              views={live}
              activeViewId={null}
              onMove={() => {}}
              forceDragging
            />
          </div>
        </Figure>
        <Figure caption={t('savedViews.dev.empty')}>
          <div className="w-sidebar rounded-md bg-bg-sidebar p-3">
            <SidebarSavedViews
              orgName={company.name}
              slug={slug}
              views={[]}
              activeViewId={null}
              onMove={() => {}}
            />
          </div>
        </Figure>
        <Figure caption={t('savedViews.dev.newActive')}>
          <div className="w-sidebar rounded-md bg-bg-sidebar p-3">
            <SidebarSavedViews
              orgName={company.name}
              slug={slug}
              views={live.slice(0, 2)}
              activeViewId="new"
              onMove={() => {}}
            />
          </div>
        </Figure>
        <Figure caption={t('savedViews.dev.rail')}>
          <div className="w-rail rounded-md bg-bg-sidebar p-2">
            <SidebarSavedViews
              rail
              orgName={company.name}
              slug={slug}
              views={live}
              activeViewId={first}
              onMove={() => {}}
            />
          </div>
        </Figure>
      </Group>
      <Group title={t('savedViews.dev.tabs')} className="flex-col items-stretch">
        <FixedSavedViews views={{ [company.id]: live }}>
          <div className="w-full max-w-list-min overflow-hidden rounded-md border border-border">
            <PhoneTabs activeSavedViewId={first} />
          </div>
        </FixedSavedViews>
      </Group>
      <Group title={t('savedViews.dev.settings')} className="flex-col items-stretch">
        <ViewsSection
          org={company}
          views={live}
          archived={archived}
          onArchive={(view) => {
            setLive((views) => views.filter((v) => v.id !== view.id));
            setArchived((views) => [...views, { ...view, archivedAt: 1 }]);
          }}
          onRestore={(view) => {
            setArchived((views) => views.filter((v) => v.id !== view.id));
            setLive((views) => [...views, { ...view, archivedAt: null }]);
          }}
          onDelete={(view) => {
            setLive((views) => views.filter((v) => v.id !== view.id));
            setArchived((views) => views.filter((v) => v.id !== view.id));
          }}
        />
      </Group>
    </>
  );
}

function PhoneTabs({ activeSavedViewId }: { activeSavedViewId: string | null }) {
  const tabs = useViewTabs(company, orgUrlSlug(company), null, activeSavedViewId);
  return <ViewSwitcher views={tabs} />;
}
