import { isLocale } from '@rooster/i18n';
import {
  createFileRoute,
  Outlet,
  redirect,
  useLocation,
  useNavigate,
  useParams,
} from '@tanstack/react-router';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  errorCode,
  findOrg,
  meQueryOptions,
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
import { setLocale } from '../lib/i18n';
import { safeRedirectPath } from '../lib/safe-redirect';
import { toast } from '../ui/toast';
import { useKeymapHandlers } from '../use-keymap';

/** The signed-in frame: sidebar + main. Signed-out visitors go to `/login` (WP 1.4). */
export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ context, location }) => {
    try {
      await context.queryClient.ensureQueryData({ ...meQueryOptions, revalidateIfStale: true });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        const target = safeRedirectPath(location.href);
        throw redirect({ to: '/login', search: target ? { redirect: target } : {} });
      }
      throw error;
    }
  },
  component: AppLayout,
});

function AppLayout() {
  const { t, i18n } = useTranslation('shell');
  const me = useMe();
  const location = useLocation();
  const navigate = useNavigate();
  const { orgSlug } = useParams({ strict: false });
  const reorder = useReorderOrg();
  const setCollapsed = useSetOrgCollapsed();
  const createOrg = useCreateOrg();
  const changeLocale = useChangeLocale();
  const signOut = useSignOut();

  // The session ended while the app was open (revoked elsewhere, signed out).
  const unauthenticated = errorCode(me.error) === 'unauthenticated';
  useEffect(() => {
    if (!unauthenticated) return;
    const target = safeRedirectPath(location.href);
    void navigate({ to: '/login', search: target ? { redirect: target } : {}, replace: true });
  }, [unauthenticated, navigate, location.href]);

  // The profile's language wins once signed in (04 §8); it starts as the browser's.
  const storedLocale = me.data?.user.locale;
  useEffect(() => {
    if (isLocale(storedLocale) && storedLocale !== i18n.language) void setLocale(storedLocale);
  }, [storedLocale, i18n.language]);

  // G-sequences and Mod+1…9 (02 §6).
  useKeymapHandlers({
    goMyTasks: () => {
      const org = (orgSlug && me.data ? findOrg(me.data.orgs, orgSlug) : null) ?? me.data?.orgs[0];
      if (!org) return false;
      void navigate({ href: paths.orgView(orgUrlSlug(org), 'my') });
    },
    goSettings: () => {
      void navigate({ to: '/settings' });
    },
    goToOrg: (event) => {
      const index = Number(event.code.replace('Digit', '') || event.key) - 1;
      const org = me.data?.orgs[index];
      if (!org) return false;
      void navigate({ href: paths.orgView(orgUrlSlug(org), 'my') });
    },
  });

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
          onSignOut={async () => {
            try {
              await signOut.mutateAsync();
              window.location.replace(paths.login);
            } catch {
              failed();
            }
          }}
        />
      )}
    >
      <Outlet />
    </AppShell>
  );
}
