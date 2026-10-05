import { createFileRoute, Outlet } from '@tanstack/react-router';
import { useMe, useOrg } from '../../data';
import { TasksScreen } from '../../features/pane/tasks-screen';
import { OrgNotFound } from '../../features/shell/org-not-found';

/**
 * My tasks with the detail pane (02 §2, §9). One layout for `/my` and `/t/:taskId`, so the
 * list stays mounted (selection, drafts, scroll) while the pane opens, follows and closes.
 */
export const Route = createFileRoute('/_app/o/$orgSlug/_tasks')({
  component: TasksLayout,
});

function TasksLayout() {
  const { orgSlug } = Route.useParams();
  const org = useOrg(orgSlug);
  const me = useMe();
  if (org.data === null) return <OrgNotFound />;
  if (!org.data || !me.data) return null;
  return (
    <>
      <TasksScreen org={org.data} orgSlug={orgSlug} userId={me.data.user.id} />
      <Outlet />
    </>
  );
}
