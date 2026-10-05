import { createFileRoute } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useMe, useOrg } from '../../data';
import { ShowCompletedToggle } from '../../features/list/header-actions';
import { MyListView } from '../../features/list/my-list-view';
import { ViewBody, ViewHeader } from '../../features/shell/app-shell';
import { OrgNotFound } from '../../features/shell/org-not-found';

export const Route = createFileRoute('/_app/o/$orgSlug/my')({
  component: MyTasksRoute,
});

function MyTasksRoute() {
  const { t } = useTranslation('shell');
  const { orgSlug } = Route.useParams();
  const org = useOrg(orgSlug);
  const me = useMe();

  if (org.data === null) return <OrgNotFound />;
  if (!org.data || !me.data) return null;
  return (
    <>
      <ViewHeader title={t('view.my')} context={org.data.name} actions={<ShowCompletedToggle />} />
      <ViewBody>
        <MyListView orgId={org.data.id} userId={me.data.user.id} label={t('view.my')} />
      </ViewBody>
    </>
  );
}
