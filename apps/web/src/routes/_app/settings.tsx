import { createFileRoute, Outlet, useLocation } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { SettingsLayout } from '../../features/settings/settings-layout';
import { ViewBody, ViewHeader } from '../../features/shell/app-shell';
import { paths, type SettingsSection } from '../../features/shell/paths';

export const Route = createFileRoute('/_app/settings')({
  component: SettingsRoute,
});

const sections: readonly SettingsSection[] = [
  'profile',
  'behaviour',
  'notifications',
  'security',
  'data',
];

/** The section in the URL; null on the index (`/settings`, phones only). */
function sectionOf(pathname: string): SettingsSection | null {
  const last = pathname.replace(/\/+$/, '').split('/').pop();
  return sections.find((section) => section === last) ?? null;
}

function SettingsRoute() {
  const { t } = useTranslation('settings');
  const { pathname } = useLocation();
  const active = sectionOf(pathname);
  return (
    <>
      {/* Phones: the index is titled Settings; a section has its own title and ‹ Settings. */}
      <ViewHeader
        title={t('title')}
        mobile={
          active
            ? { title: t(`nav.${active}`), back: { href: paths.settingsIndex, label: t('title') } }
            : undefined
        }
      />
      <ViewBody>
        <SettingsLayout active={active ?? 'profile'}>
          <Outlet />
        </SettingsLayout>
      </ViewBody>
    </>
  );
}
