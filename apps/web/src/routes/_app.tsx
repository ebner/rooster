import {
  createFileRoute,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
} from '@tanstack/react-router';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  errorCode,
  findOrg,
  useChangeLocale,
  useCreateOrg,
  useMe,
  useReorderOrg,
  useSetOrgCollapsed,
  useSignOut,
} from '../data';
import { AppShell } from '../features/shell/app-shell';
import { orgUrlSlug, paths } from '../features/shell/paths';
import { Sidebar } from '../features/shell/sidebar';
import { toast } from '../ui/toast';

/** The signed-in frame: sidebar + main, for every route under it. */
export const Route = createFileRoute('/_app')({
  component: AppLayout,
});

function AppLayout() {
  const { t } = useTranslation('shell');
  const me = useMe();
  const location = useLocation();
  const navigate = useNavigate();
  const { orgSlug } = useParams({ strict: false });
  const reorder = useReorderOrg();
  const setCollapsed = useSetOrgCollapsed();
  const createOrg = useCreateOrg();
  const changeLocale = useChangeLocale();
  const signOut = useSignOut();

  const unauthenticated = errorCode(me.error) === 'unauthenticated';
  useEffect(() => {
    if (unauthenticated) {
      void navigate({ to: '/login', search: { redirect: location.pathname }, replace: true });
    }
  }, [unauthenticated]);

  if (!me.data) return null;

  const { user, orgs } = me.data;
  const activeOrg = orgSlug ? findOrg(orgs, orgSlug) : null;
  const activeView = location.pathname.endsWith('/my') ? 'my' : null;
  const failed = () => toast({ message: t('error.saveFailed'), tone: 'danger' });

  return (
    <AppShell
      navKey={location.pathname}
      renderSidebar={({ collapsed, onToggleCollapsed, inDrawer }) => (
        <Sidebar
          user={user}
          orgs={orgs}
          active={activeOrg && activeView ? { orgId: activeOrg.id, view: activeView } : null}
          locale={user.locale}
          collapsed={collapsed}
          onToggleCollapsed={onToggleCollapsed}
          inDrawer={inDrawer}
          onReorder={(intent) => reorder.mutateAsync(intent).catch(failed)}
          onToggleOrgCollapsed={(orgId, value) =>
            setCollapsed.mutateAsync({ orgId, collapsed: value }).catch(failed)
          }
          onCreateOrg={async (input) => {
            const org = await createOrg.mutateAsync(input);
            toast({ message: t('createOrg.created', { name: org.name }) });
            await navigate({ href: paths.orgView(orgUrlSlug(org), 'my') });
          }}
          onLocaleChange={(locale) => changeLocale.mutateAsync(locale).catch(failed)}
          onSignOut={() => signOut.mutateAsync().catch(failed)}
        />
      )}
    >
      <Outlet />
    </AppShell>
  );
}
