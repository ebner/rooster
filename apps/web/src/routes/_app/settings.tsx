import { createFileRoute, Outlet, useLocation } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { SettingsLayout } from '../../features/settings/settings-layout';
import { ViewBody, ViewHeader } from '../../features/shell/app-shell';

export const Route = createFileRoute('/_app/settings')({
  component: SettingsRoute,
});

function SettingsRoute() {
  const { t } = useTranslation('settings');
  const { pathname } = useLocation();
  const active = pathname.endsWith('/security')
    ? 'security'
    : pathname.endsWith('/behaviour')
      ? 'behaviour'
      : 'profile';
  return (
    <>
      <ViewHeader title={t('title')} />
      <ViewBody>
        <SettingsLayout active={active}>
          <Outlet />
        </SettingsLayout>
      </ViewBody>
    </>
  );
}
