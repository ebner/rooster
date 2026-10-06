import { createFileRoute, Outlet, useLocation } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useMe, useOrg } from '../../data';
import { TasksScreen } from '../../features/pane/tasks-screen';
import { OrgNotFound } from '../../features/shell/org-not-found';
import { listViewOf, useLastListView, viewOfPath } from '../../features/views/last-view';

/**
 * My tasks and the smart views with the detail pane (02 §2, §9, §10). One layout for
 * `/my`, `/today`, `/week`, `/overdue`, `/nodate` and `/t/:taskId`, so the list stays mounted
 * (selection, drafts, scroll) while the pane opens, follows and closes over the last view.
 */
export const Route = createFileRoute('/_app/o/$orgSlug/_tasks')({
  component: TasksLayout,
});

function TasksLayout() {
  const { orgSlug } = Route.useParams();
  const { pathname } = useLocation();
  const org = useOrg(orgSlug);
  const me = useMe();
  const lastView = useLastListView((s) => s.view);
  const view = listViewOf(pathname, lastView) ?? 'my';
  const ownView = viewOfPath(pathname);
  useEffect(() => {
    if (ownView) useLastListView.setState({ view: ownView });
  }, [ownView]);
  if (org.data === null) return <OrgNotFound />;
  if (!org.data || !me.data) return null;
  return (
    <>
      <TasksScreen org={org.data} orgSlug={orgSlug} userId={me.data.user.id} view={view} />
      <Outlet />
    </>
  );
}
