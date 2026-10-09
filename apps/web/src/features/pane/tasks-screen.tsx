import type { ListState } from '@rooster/core/reducers';
import { useNavigate, useParams, useRouter } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useMyListSelect } from '../../data/list';
import { useOrgMembers } from '../../data/orgs';
import type { Org } from '../../data/types';
import { useListStore } from '../../state/list-store';
import { usePaneStore } from '../../state/pane-store';
import { isMobileViewport } from '../../ui/use-media';
import { ShowCompletedMenuItem, ShowCompletedToggle } from '../list/header-actions';
import { MyListView } from '../list/my-list-view';
import { EveryoneFilterButton } from '../people/everyone-filters';
import { ViewBody, ViewHeader } from '../shell/app-shell';
import { type OrgViewId, paths } from '../shell/paths';
import { TagFilterButton } from '../tags/tag-filter';
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
  view?: () => OrgViewId;
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
      if (!deps.back?.()) deps.go(paths.orgView(deps.orgSlug, deps.view?.() ?? 'my'), true);
      if (hadFocus) deps.focusList();
    },
    toggleFullScreen: () => {
      const store = usePaneStore.getState();
      store.setFullScreen(!store.fullScreen);
    },
  };
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
  /** My tasks or a smart view (02 §10); the pane opens over it. */
  view?: OrgViewId;
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
  const shared = !org.isPersonal;
  // FR-COL-6: a personal org has no Everyone's tasks; its URL shows My tasks.
  const everyone = view === 'everyone' && shared;
  const tabs = useViewTabs(org, orgSlug, everyone || view !== 'everyone' ? view : 'my');
  const title = t(`view.${everyone || view !== 'everyone' ? view : 'my'}`);
  const members = useOrgMembers(everyone ? org.id : undefined).data;
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
  useEffect(() => {
    if (!taskId || !inList) return;
    const store = useListStore.getState();
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
        <>
          <InteractionPrefetch />
          <ViewHeader
            title={title}
            context={org.name}
            actions={
              everyone ? (
                <>
                  <EveryoneFilterButton members={members ?? []} meId={userId} />
                  <TagFilterButton orgId={org.id} />
                </>
              ) : (
                <>
                  <TagFilterButton orgId={org.id} />
                  <ShowCompletedToggle />
                </>
              )
            }
            mobile={{
              switcher: true,
              actions: everyone ? (
                <>
                  <EveryoneFilterButton members={members ?? []} meId={userId} />
                  <TagFilterButton orgId={org.id} />
                </>
              ) : (
                <TagFilterButton orgId={org.id} />
              ),
              // Everyone's tasks lists open tasks only (02 §11).
              menu: everyone ? undefined : <ShowCompletedMenuItem />,
              views: tabs,
            }}
          />
          <ViewBody>
            <MyListView
              orgId={org.id}
              userId={userId}
              label={title}
              pane={pane}
              view={view === 'my' || view === 'everyone' ? undefined : view}
              shared={shared}
              everyone={everyone}
            />
          </ViewBody>
        </>
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
