import type { ListState } from '@rooster/core/reducers';
import { useNavigate, useParams, useRouter } from '@tanstack/react-router';
import { Suspense, useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useMyListSelect } from '../../data/list';
import { useOrgMembers } from '../../data/orgs';
import type { Org } from '../../data/types';
import { preloadWhenIdle } from '../../lib/lazy';
import { useListStore } from '../../state/list-store';
import { usePaneStore } from '../../state/pane-store';
import { isMobileViewport } from '../../ui/use-media';
import {
  ListHeaderMenu,
  ListMenuItems,
  type ListMenuView,
  ShowCompletedToggle,
  useListPrint,
} from '../list/header-actions';
import { MyListView } from '../list/my-list-view';
import { EveryoneFilterButton, useEveryoneFilters } from '../people/everyone-filters';
import { LazySavedViewContent } from '../saved-views/lazy';
import { queryFromEveryone, queryFromTagFilter } from '../saved-views/query';
import { useSaveAsView } from '../saved-views/save-as-view';
import { ViewBody, ViewHeader } from '../shell/app-shell';
import { type OrgViewId, paths } from '../shell/paths';
import { TagFilterButton } from '../tags/tag-filter';
import { type ListViewKey, orgViewOf, savedViewIdOf } from '../views/last-view';
import { useViewTabs } from '../views/view-tabs';
import { InteractionPrefetch } from './description-field';
import { DetailPane } from './detail-pane';
import type { PaneControls } from './pane-controls';
import { SplitView } from './split-view';

/** The pane element holding focus, if any. */
function focusInPane(): boolean {
  return Boolean(document.activeElement?.closest('[data-pane-root]'));
}

/**
 * My tasks plus the detail pane (02 §9). The URL is the pane's state: `/o/:org/t/:id` opens
 * it; following the selection replaces the entry, so Back leaves the pane instead of walking
 * through every task looked at.
 */
/**
 * The pane's controls over the URL (02 §2, §3.2): opening from a closed pane pushes a history
 * entry; switching tasks (following the selection) and closing replace it.
 */
export function createPaneControls(deps: {
  current: () => string | null;
  setCurrent: (taskId: string | null) => void;
  go: (href: string, replace: boolean) => void;
  orgSlug: string;
  /** The list view under the pane (02 §2): closing returns to it. */
  view?: () => ListViewKey;
  focusList: () => void;
  /**
   * Phones (02 §13.4): the sheet is a history entry, so closing it steps back when this
   * session pushed that entry. Returns false to fall back to replacing the URL.
   */
  back?: () => boolean;
}): PaneControls {
  return {
    taskId: deps.current,
    open: (id, focus) => {
      if (focus) usePaneStore.getState().requestFocus(focus);
      const current = deps.current();
      if (id === current) return;
      deps.setCurrent(id);
      deps.go(paths.task(deps.orgSlug, id), current !== null);
    },
    close: () => {
      if (deps.current() === null) return;
      const hadFocus = focusInPane();
      deps.setCurrent(null);
      usePaneStore.getState().setFullScreen(false);
      if (!deps.back?.()) deps.go(listViewHref(deps.orgSlug, deps.view?.() ?? 'my'), true);
      if (hadFocus) deps.focusList();
    },
    followToOrg: (orgSlug) => {
      const current = deps.current();
      if (current === null || orgSlug === deps.orgSlug) return;
      deps.go(paths.task(orgSlug, current), true);
    },
    toggleFullScreen: () => {
      const store = usePaneStore.getState();
      store.setFullScreen(!store.fullScreen);
    },
  };
}

/** The address of a list view of the org: a built-in one, or a view (`v:<id>`, ADR 0073 B). */
export function listViewHref(orgSlug: string, view: ListViewKey): string {
  const saved = savedViewIdOf(view);
  return saved ? paths.savedView(orgSlug, saved) : paths.orgView(orgSlug, orgViewOf(view) ?? 'my');
}

/** Esc out of the pane (02 §9.1): focus returns to the selected row, if any. */
export function focusListCursor(): void {
  const store = useListStore.getState();
  if (store.cursor) store.navigate(store.cursor);
  else (document.activeElement as HTMLElement | null)?.blur?.();
}

export function TasksScreen({
  org,
  orgSlug,
  userId,
  view = 'my',
}: {
  org: Org;
  orgSlug: string;
  userId: string;
  /**
   * My tasks, a smart view (02 §10), Everyone's tasks, or (Phase 13) a view of the org
   * (`v:<id>`, `v:new` for "+ New view"); the pane opens over it.
   */
  view?: ListViewKey;
}) {
  const { t } = useTranslation('shell');
  const { t: tPane } = useTranslation('pane');
  const navigate = useNavigate();
  const router = useRouter();
  /** Whether this session pushed the pane's history entry (a phone's ‹ back pops it). */
  const pushed = useRef(false);
  const params = useParams({ strict: false }) as { taskId?: string };
  const taskId = params.taskId ?? null;
  const taskRef = useRef(taskId);
  taskRef.current = taskId;
  const fullScreen = usePaneStore((s) => s.fullScreen);
  const viewRef = useRef(view);
  viewRef.current = view;
  const savedViewId = savedViewIdOf(view);
  const shared = !org.isPersonal;
  // FR-COL-6: a personal org has no Everyone's tasks; its URL shows My tasks.
  const everyone = view === 'everyone' && shared;
  const builtIn: OrgViewId = orgViewOf(view) ?? 'my';
  const tabs = useViewTabs(org, orgSlug, everyone || view !== 'everyone' ? view : 'my');
  const title = t(`view.${everyone || builtIn !== 'everyone' ? builtIn : 'my'}`);
  const members = useOrgMembers(everyone ? org.id : undefined).data;
  const menuView: ListMenuView = everyone
    ? 'everyone'
    : builtIn === 'my' || builtIn === 'everyone'
      ? 'my'
      : 'smart';
  useListPrint();
  useEffect(() => preloadWhenIdle([LazySavedViewContent.preload]), []);
  // ADR 0073 B7: "Save as view" from My tasks' tag filter and Everyone's filters.
  const saveAs = useSaveAsView(org);
  const tagFilter = useListStore((s) => s.tagFilter);
  const everyoneFilters = useEveryoneFilters();
  const tagSaveAs = everyone
    ? (tagIds: string[]) => saveAs(queryFromEveryone({ ...everyoneFilters, tagIds }))
    : builtIn === 'my'
      ? (tagIds: string[]) => saveAs(queryFromTagFilter(tagIds))
      : undefined;
  const everyoneSaveAs = {
    filtered:
      tagFilter.length > 0 || everyoneFilters.due !== 'any' || everyoneFilters.members.length > 0,
    run: () => saveAs(queryFromEveryone({ ...everyoneFilters, tagIds: tagFilter })),
  };
  useEffect(() => {
    if (view === 'everyone' && !shared && !taskId) {
      void navigate({ href: paths.orgView(orgSlug, 'my'), replace: true });
    }
  }, [view, shared, taskId, navigate, orgSlug]);

  const focusList = focusListCursor;

  const pane = useMemo(
    () =>
      createPaneControls({
        current: () => taskRef.current,
        setCurrent: (id) => {
          taskRef.current = id;
        },
        go: (href, replace) => {
          if (!replace) pushed.current = true;
          void navigate({ href, replace });
        },
        back: () => {
          if (!isMobileViewport() || !pushed.current) return false;
          pushed.current = false;
          router.history.back();
          return true;
        },
        orgSlug,
        view: () => viewRef.current,
        focusList,
      }),
    [navigate, router, orgSlug],
  );

  // A boolean slice, not the list data: the frame must not re-render per keypress (AC-2.12).
  // A deep link selects its row once the task is in the list (it may arrive after the first
  // render, e.g. when the screen mounts over a restored cache); otherwise nothing is selected.
  // Selecting moves focus to the row and scrolls it into view (`MyListView`).
  const inList =
    useMyListSelect(
      org.id,
      useCallback((state: ListState) => (taskId ? taskId in state.tasks : false), [taskId]),
    ).data === true;
  // Keyed on the task and its presence only (not the selection), so moving the selection
  // later never snaps it back; re-running is harmless (e.g. StrictMode's second mount pass).
  // A title being typed keeps its edit: the pane follows a task just created while the caret
  // waits in the new row below it (ADR 0064), and selecting would orphan that row.
  useEffect(() => {
    if (!taskId || !inList) return;
    const store = useListStore.getState();
    if (store.editing !== null) return;
    if (store.cursor !== taskId && document.querySelector(`[data-row-id="${taskId}"]`)) {
      store.select(taskId);
    }
  }, [taskId, inList]);

  useEffect(() => {
    if (taskId) usePaneStore.setState({ lastTaskId: taskId });
    else {
      usePaneStore.getState().setFullScreen(false);
      pushed.current = false;
    }
  }, [taskId]);

  return (
    <SplitView
      label={tPane('label')}
      onDismiss={() => pane.close()}
      list={
        savedViewId ? (
          <>
            <InteractionPrefetch />
            <Suspense fallback={null}>
              <LazySavedViewContent
                org={org}
                userId={userId}
                viewId={savedViewId}
                pane={pane}
                tabs={tabs}
              />
            </Suspense>
          </>
        ) : (
          <>
            <InteractionPrefetch />
            <ViewHeader
              title={title}
              context={org.name}
              actions={
                everyone ? (
                  <>
                    <EveryoneFilterButton
                      members={members ?? []}
                      meId={userId}
                      onSaveAsView={everyoneSaveAs}
                    />
                    <TagFilterButton orgId={org.id} onSaveAsView={tagSaveAs} />
                    <ListHeaderMenu orgId={org.id} view={menuView} />
                  </>
                ) : (
                  <>
                    <TagFilterButton orgId={org.id} onSaveAsView={tagSaveAs} />
                    <ShowCompletedToggle />
                    <ListHeaderMenu orgId={org.id} view={menuView} />
                  </>
                )
              }
              mobile={{
                switcher: true,
                actions: everyone ? (
                  <>
                    <EveryoneFilterButton
                      members={members ?? []}
                      meId={userId}
                      onSaveAsView={everyoneSaveAs}
                    />
                    <TagFilterButton orgId={org.id} onSaveAsView={tagSaveAs} />
                  </>
                ) : (
                  <TagFilterButton orgId={org.id} onSaveAsView={tagSaveAs} />
                ),
                // 02 §2: the list's ⋯ items (Everyone's tasks lists open tasks only, 02 §11).
                menu: <ListMenuItems orgId={org.id} view={menuView} mobile />,
                views: tabs,
              }}
            />
            {/* Printed above the list only (styles/print.css). */}
            <p data-print-title className="hidden">
              {title} <span>{org.name}</span>
            </p>
            <ViewBody>
              <MyListView
                orgId={org.id}
                userId={userId}
                label={title}
                pane={pane}
                view={builtIn === 'my' || builtIn === 'everyone' ? undefined : builtIn}
                shared={shared}
                everyone={everyone}
              />
            </ViewBody>
          </>
        )
      }
      pane={
        taskId ? (
          <DetailPane
            orgId={org.id}
            orgSlug={orgSlug}
            userId={userId}
            taskId={taskId}
            pane={pane}
            fullScreen={fullScreen}
            onFocusList={focusList}
          />
        ) : null
      }
    />
  );
}
