import { createFileRoute } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useMyGroups, useOrg } from '../../data';
import { MyTasksPlaceholder } from '../../features/list/placeholder';
import { ViewBody, ViewHeader } from '../../features/shell/app-shell';
import { OrgNotFound } from '../../features/shell/org-not-found';

export const Route = createFileRoute('/_app/o/$orgSlug/my')({
  component: MyTasksRoute,
});

function MyTasksRoute() {
  const { t } = useTranslation('shell');
  const { orgSlug } = Route.useParams();
  const org = useOrg(orgSlug);
  const groups = useMyGroups(org.data?.id);

  if (org.data === null) return <OrgNotFound />;
  if (!org.data) return null;
  return (
    <>
      <ViewHeader title={t('view.my')} context={org.data.name} />
      <ViewBody>
        <MyTasksPlaceholder groups={groups.data ?? []} />
      </ViewBody>
    </>
  );
}
