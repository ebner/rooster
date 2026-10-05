import { useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useListPipeline, useMyListStatus } from '../../data/list';
import type { Org } from '../../data/types';
import { useListStore } from '../../state/list-store';
import { usePaneStore } from '../../state/pane-store';
import { ShowCompletedToggle } from '../list/header-actions';
import { MyListView } from '../list/my-list-view';
import { ViewBody, ViewHeader } from '../shell/app-shell';
import { paths } from '../shell/paths';
import { TagFilterButton } from '../tags/tag-filter';
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
  focusList: () => void;
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
      deps.go(paths.orgView(deps.orgSlug, 'my'), true);
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
}: {
  org: Org;
  orgSlug: string;
  userId: string;
}) {
  const { t } = useTranslation('shell');
  const { t: tPane } = useTranslation('pane');
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { taskId?: string };
  const taskId = params.taskId ?? null;
  const taskRef = useRef(taskId);
  taskRef.current = taskId;
  const fullScreen = usePaneStore((s) => s.fullScreen);
  // Status only: subscribing to the list data would re-render the header and the whole list
  // frame on every keypress (AC-2.12).
  const listReady = useMyListStatus(org.id).ready;
  const pipeline = useListPipeline();

  const focusList = focusListCursor;

  const pane = useMemo(
    () =>
      createPaneControls({
        current: () => taskRef.current,
        setCurrent: (id) => {
          taskRef.current = id;
        },
        go: (href, replace) => void navigate({ href, replace }),
        orgSlug,
        focusList,
      }),
    [navigate, orgSlug],
  );

  // A deep link selects its row when the task is in view; otherwise nothing is selected.
  const linked = useRef<string | null>(null);
  useEffect(() => {
    const state = pipeline.view(org.id);
    if (!taskId || !listReady || !state || linked.current === taskId) return;
    linked.current = taskId;
    const store = useListStore.getState();
    if (store.cursor === taskId) return;
    if (state.tasks[taskId] && document.querySelector(`[data-row-id="${taskId}"]`)) {
      store.select(taskId);
    }
  }, [taskId, listReady, pipeline, org.id]);

  useEffect(() => {
    if (taskId) usePaneStore.setState({ lastTaskId: taskId });
    else usePaneStore.getState().setFullScreen(false);
  }, [taskId]);

  return (
    <SplitView
      label={tPane('label')}
      list={
        <>
          <ViewHeader
            title={t('view.my')}
            context={org.name}
            actions={
              <>
                <TagFilterButton orgId={org.id} />
                <ShowCompletedToggle />
              </>
            }
          />
          <ViewBody>
            <MyListView orgId={org.id} userId={userId} label={t('view.my')} pane={pane} />
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
