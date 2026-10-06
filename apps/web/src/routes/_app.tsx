import { isLocale } from '@rooster/i18n/core';
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
import { MobileNav } from '../features/shell/mobile-nav';
import { type OrgViewId, orgUrlSlug, paths } from '../features/shell/paths';
import { Sidebar } from '../features/shell/sidebar';
import { listViewOf, useLastListView } from '../features/views/last-view';
import { LiveViewCounts } from '../features/views/view-counts';
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
  const lastView = useLastListView((s) => s.view);

  // The session ended while the app was open (revoked elsewhere, signed out).
  const unauthenticated = errorCode(me.error) === 'unauthenticated';
  useEffect(() => {
    // Already on the way out: the location changes before this layout unmounts, and a second
    // redirect would nest `redirect=/login?redirect=…` without end.
    if (!unauthenticated || location.pathname === '/login') return;
    const target = safeRedirectPath(location.href);
    void navigate({ to: '/login', search: target ? { redirect: target } : {}, replace: true });
  }, [unauthenticated, navigate, location.href, location.pathname]);

  // The profile's language wins once signed in (04 §8); it starts as the browser's.
  const storedLocale = me.data?.user.locale;
  useEffect(() => {
    if (isLocale(storedLocale) && storedLocale !== i18n.language) void setLocale(storedLocale);
  }, [storedLocale, i18n.language]);

  /** G then M / T / W / O / N (02 §6): a view of the current org (or the first one). */
  const goTo = (view: OrgViewId) => {
    const org = (orgSlug && me.data ? findOrg(me.data.orgs, orgSlug) : null) ?? me.data?.orgs[0];
    if (!org) return false;
    void navigate({ href: paths.orgView(orgUrlSlug(org), view) });
  };

  // G-sequences and Mod+1…9 (02 §6).
  useKeymapHandlers({
    goMyTasks: () => goTo('my'),
    goToday: () => goTo('today'),
    goWeek: () => goTo('week'),
    goOverdue: () => goTo('overdue'),
    goNoDate: () => goTo('nodate'),
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
  // The pane (`/t/:taskId`) sits over the last list view (02 §2).
  const activeView = listViewOf(location.pathname, lastView);
  const failed = () => toast({ message: t('error.saveFailed'), tone: 'danger' });
  const homeOrg = activeOrg ?? orgs[0] ?? null;
  const createOrgAndGo = async (input: Parameters<typeof createOrg.mutateAsync>[0]) => {
    const org = await createOrg.mutateAsync(input);
    toast({ message: t('createOrg.created', { name: org.name }) });
    await navigate({ href: paths.orgView(orgUrlSlug(org), 'my') });
  };
  const signOutNow = async () => {
    try {
      await signOut.mutateAsync();
      window.location.replace(paths.login);
    } catch {
      failed();
    }
  };

  return (
    <LiveViewCounts>
      <AppShell
        navKey={location.pathname}
        mobile={{
          orgs,
          activeOrg: activeOrg ?? null,
          isAdmin: user.isAdmin,
          onSelectOrg: (org) => void navigate({ href: paths.orgView(orgUrlSlug(org), 'my') }),
          onCreateOrg: createOrgAndGo,
          onSignOut: () => void signOutNow(),
          nav: (
            <MobileNav
              myTasksHref={homeOrg ? paths.orgView(orgUrlSlug(homeOrg), 'my') : null}
              active={
                activeView !== null
                  ? 'my'
                  : location.pathname.startsWith('/settings')
                    ? 'settings'
                    : null
              }
            />
          ),
        }}
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
            onCreateOrg={createOrgAndGo}
            onLocaleChange={(locale) => changeLocale.mutateAsync(locale).catch(failed)}
            onSignOut={signOutNow}
          />
        )}
      >
        <Outlet />
      </AppShell>
    </LiveViewCounts>
  );
}
