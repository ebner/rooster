import { useNavigate, useParams, useRouter } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTaskOrg } from '../../data/all-views';
import type { Me } from '../../data/types';
import { useListStore } from '../../state/list-store';
import { usePaneStore } from '../../state/pane-store';
import { isMobileViewport } from '../../ui/use-media';
import {
  ListHeaderMenu,
  ListMenuItems,
  ShowCompletedToggle,
  useListPrint,
} from '../list/header-actions';
import { InteractionPrefetch } from '../pane/description-field';
import { DetailPane } from '../pane/detail-pane';
import type { PaneControls } from '../pane/pane-controls';
import { SplitView } from '../pane/split-view';
import { focusListCursor } from '../pane/tasks-screen';
import { ViewBody, ViewHeader } from '../shell/app-shell';
import { type AllViewId, orgUrlSlug, paths } from '../shell/paths';
import { useAllViewTabs } from '../views/view-tabs';
import { AllListView } from './all-list-view';
import { defaultOrgOf } from './default-org';

/** The element holding focus is in the pane. */
function focusInPane(): boolean {
  return Boolean(document.activeElement?.closest('[data-pane-root]'));
}

/**
 * The pane over All organisations (02 §9, §10.1): `/all/t/<id>` opens it over the last All view;
 * opening from a closed pane pushes a history entry, following the selection and closing
 * replace it. The task keeps its own org (each op is queued there).
 */
export function createAllPaneControls(deps: {
  current: () => string | null;
  setCurrent: (taskId: string | null) => void;
  go: (href: string, replace: boolean) => void;
  view: () => AllViewId;
  /** ADR 0072: the pane's task moved to the org with this slug. */
  followToOrg: (orgSlug: string) => void;
  back?: () => boolean;
}): PaneControls {
  return {
    taskId: deps.current,
    open: (id, focus) => {
      if (focus) usePaneStore.getState().requestFocus(focus);
      const current = deps.current();
      if (id === current) return;
      deps.setCurrent(id);
      deps.go(paths.allTask(id), current !== null);
    },
    close: () => {
      if (deps.current() === null) return;
      const hadFocus = focusInPane();
      deps.setCurrent(null);
      usePaneStore.getState().setFullScreen(false);
      if (!deps.back?.()) deps.go(paths.allView(deps.view()), true);
      if (hadFocus) focusListCursor();
    },
    followToOrg: deps.followToOrg,
    toggleFullScreen: () => {
      const store = usePaneStore.getState();
      store.setFullScreen(!store.fullScreen);
    },
  };
}

/**
 * All organisations → Today, Next 7 days or Overdue (ADR 0073 A, 02 §10.1), with the detail
 * pane. The header names the view with "All organisations" as its context; phones switch views
 * in the header's switcher.
 */
export function AllScreen({ me, view }: { me: Me; view: AllViewId }) {
  const { t } = useTranslation('shell');
  const { t: tViews } = useTranslation('views');
  const { t: tPane } = useTranslation('pane');
  const navigate = useNavigate();
  const router = useRouter();
  const pushed = useRef(false);
  const params = useParams({ strict: false }) as { taskId?: string };
  const taskId = params.taskId ?? null;
  const taskRef = useRef(taskId);
  taskRef.current = taskId;
  const viewRef = useRef(view);
  viewRef.current = view;
  const fullScreen = usePaneStore((s) => s.fullScreen);
  const tabs = useAllViewTabs(view);
  const title = t(`view.${view}`);
  const context = tViews('all.title');
  const orgs = me.orgs;
  const orgIds = useMemo(() => orgs.map((org) => org.id), [orgs]);
  const defaultOrg = defaultOrgOf(me);
  useListPrint();

  // The pane's task is in one of the orgs' lists; a task none of them holds (a link to
  // someone else's task) is looked up under the default org, and the pane follows it to its
  // own org (ADR 0072 §23).
  const listOrg = useTaskOrg(orgIds, taskId);
  const [followed, setFollowed] = useState<{ taskId: string; orgId: string } | null>(null);
  const paneOrgId =
    listOrg ??
    (followed && followed.taskId === taskId ? followed.orgId : undefined) ??
    (listOrg === null ? defaultOrg?.id : undefined);
  const paneOrg = orgs.find((org) => org.id === paneOrgId);

  const pane = useMemo(
    () =>
      createAllPaneControls({
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
        view: () => viewRef.current,
        followToOrg: (orgSlug) => {
          const org = orgs.find((o) => orgUrlSlug(o) === orgSlug || o.slug === orgSlug);
          const current = taskRef.current;
          if (org && current) setFollowed({ taskId: current, orgId: org.id });
        },
      }),
    [navigate, router, orgs],
  );

  // A deep link selects its row once the task is on screen (02 §9.1), as in an org's views.
  const inList = Boolean(listOrg);
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
        <>
          <InteractionPrefetch />
          <ViewHeader
            title={title}
            context={context}
            actions={
              <>
                <ShowCompletedToggle />
                <ListHeaderMenu orgId="" view="all" />
              </>
            }
            mobile={{
              switcher: true,
              menu: <ListMenuItems orgId="" view="all" mobile />,
              views: tabs,
            }}
          />
          {/* Printed above the list only (styles/print.css). */}
          <p data-print-title className="hidden">
            {title} <span>{context}</span>
          </p>
          <ViewBody>
            <AllListView
              orgs={orgs}
              userId={me.user.id}
              defaultOrgId={defaultOrg?.id ?? ''}
              view={view}
              label={`${title}, ${context}`}
              pane={pane}
            />
          </ViewBody>
        </>
      }
      pane={
        taskId && paneOrg ? (
          <DetailPane
            orgId={paneOrg.id}
            orgSlug={orgUrlSlug(paneOrg)}
            userId={me.user.id}
            taskId={taskId}
            pane={pane}
            fullScreen={fullScreen}
            onFocusList={focusListCursor}
          />
        ) : null
      }
    />
  );
}
