import { LogOut, Settings, ShieldCheck } from 'lucide-react';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CreateOrgInput, Org } from '../../data/types';
import { cn } from '../../lib/cn';
import { useListStore } from '../../state/list-store';
import { MenuItem, MenuSeparator } from '../../ui/menu';
import { useBreakpoint, useEditingFocus, useIsMobile } from '../../ui/use-media';
import { useKeymapHandlers } from '../../use-keymap';
import { LiveInbox } from '../collab/inbox-nav';
import { PaletteHost } from '../palette/palette-host';
import { openPalette, togglePalette } from '../palette/store';
import { SyncStatus } from '../pwa/sync-status';
import { CheatSheet, toggleCheatSheet } from './cheat-sheet';
import { MobileHeader, OrgSwitcherSheet, type ViewTab } from './mobile-header';
import { orgUrlSlug, paths } from './paths';
import { useSidebarCollapsed } from './use-sidebar-collapsed';

export interface ShellSidebarState {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** True for the copy that expands over the content (the tablet rail, 02 §2). */
  inDrawer: boolean;
}

/** What the phone frame needs from the signed-in layout (02 §13.1). */
export interface MobileShell {
  orgs: readonly Org[];
  activeOrg: Org | null;
  isAdmin: boolean;
  onSelectOrg: (org: Org) => void;
  /** Resolve to close the sheet; throw to show the error in the form. */
  onCreateOrg: (input: CreateOrgInput) => Promise<void>;
  onSignOut: () => void;
  /** The bottom nav (My tasks · Search · Inbox · Settings). */
  nav: ReactNode;
}

interface ShellContextValue {
  mobile: MobileShell | null;
  openOrgs: () => void;
}

const ShellContext = createContext<ShellContextValue | null>(null);

export interface AppShellProps {
  /** Inline (rail or full), plus the copy that expands over the content on tablets. */
  renderSidebar: (state: ShellSidebarState) => ReactNode;
  children: ReactNode;
  /** Closes the tablet's expanded sidebar whenever this changes (e.g. the pathname). */
  navKey?: string | undefined;
  /** The phone frame's data; without it phones get the plain column (kitchen sink). */
  mobile?: MobileShell | undefined;
}

/**
 * The app frame per breakpoint (02 §2, §13):
 * - desktop: sidebar (or the 56 px rail, persisted, Mod+\) + main;
 * - tablet: the icon rail; expanding opens the full sidebar over the content with a scrim;
 * - phone: main + the bottom nav; the org switcher lives in the header (`ViewHeader`).
 */
export function AppShell({ renderSidebar, children, navKey, mobile }: AppShellProps) {
  const [collapsed, toggleCollapsed] = useSidebarCollapsed();
  const breakpoint = useBreakpoint();
  const [railOpen, setRailOpen] = useState(false);
  const [orgsOpen, setOrgsOpen] = useState(false);
  const editingFocus = useEditingFocus();
  const selectionMode = useListStore((s) => s.selectionMode);
  const tablet = breakpoint === 'tablet';

  useKeymapHandlers({
    toggleSidebar: () => {
      if (tablet) setRailOpen((open) => !open);
      else toggleCollapsed();
    },
    cheatSheet: () => toggleCheatSheet(),
    // 02 §6, §12: Mod+K toggles the palette (even while typing); / opens it to search tasks.
    search: () => togglePalette(),
    focusSearch: () => openPalette({ mode: 'search' }),
  });

  useEffect(() => {
    setRailOpen(false);
    setOrgsOpen(false);
  }, [navKey]);
  useEffect(() => {
    if (!tablet) setRailOpen(false);
  }, [tablet]);
  useEffect(() => {
    if (!railOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setRailOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [railOpen]);

  const phoneFrame = breakpoint === 'mobile' && mobile !== undefined;
  useEffect(() => {
    if (!phoneFrame) return;
    const root = document.documentElement;
    root.dataset.frame = 'mobile';
    return () => {
      delete root.dataset.frame;
    };
  }, [phoneFrame]);

  const context = useMemo(
    () => ({ mobile: mobile ?? null, openOrgs: () => setOrgsOpen(true) }),
    [mobile],
  );

  if (phoneFrame && mobile) {
    return (
      <LiveInbox>
        <ShellContext.Provider value={context}>
          {/*
           * Fixed to the layout viewport rather than `h-dvh` in the flow: the nav stays flush with
           * the bottom even when `dvh` and the standalone window disagree, and a document scroll
           * cannot move the frame (the document itself is locked, theme.css).
           */}
          <div
            className="fixed inset-0 flex flex-col overflow-hidden bg-bg-app"
            data-shell="mobile"
          >
            {/*
             * Relative: the scroller is the containing block of absolutely positioned content
             * (React Aria's visually hidden inputs). Otherwise that content escapes it, and
             * focusing it scrolls the frame itself off screen.
             */}
            <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-y-none">
              {children}
            </main>
            {/* The keyboard and selection mode's bulk bar take the nav's place (02 §13). */}
            {!editingFocus && !selectionMode && mobile.nav}
            {/*
             * Selection mode's bar is fixed where the nav was: keep the nav's room so the list
             * ends above the bar instead of under it (WCAG 2.5.8, 2.4.11).
             */}
            {!editingFocus && selectionMode && (
              <div aria-hidden className="h-bottom-nav-safe shrink-0" />
            )}
            <OrgSwitcherSheet
              isOpen={orgsOpen}
              onOpenChange={setOrgsOpen}
              orgs={mobile.orgs}
              activeOrgId={mobile.activeOrg?.id}
              onSelect={mobile.onSelectOrg}
              onCreateOrg={mobile.onCreateOrg}
            />
            <CheatSheet />
            <PaletteHost />
          </div>
        </ShellContext.Provider>
      </LiveInbox>
    );
  }

  return (
    <LiveInbox>
      <ShellContext.Provider value={context}>
        <div className="flex h-dvh overflow-hidden bg-bg-app">
          {/* Before the sidebar: same layer, so the expanded sidebar paints over it. */}
          {tablet && railOpen && (
            <div
              aria-hidden
              data-testid="rail-scrim"
              onClick={() => setRailOpen(false)}
              className="fixed inset-0 z-(--z-sidebar) bg-overlay animate-fade-in"
            />
          )}
          <div className="relative z-(--z-sidebar) hidden shrink-0 border-e border-border tablet:block">
            {tablet
              ? renderSidebar({
                  collapsed: true,
                  onToggleCollapsed: () => setRailOpen(true),
                  inDrawer: false,
                })
              : renderSidebar({ collapsed, onToggleCollapsed: toggleCollapsed, inDrawer: false })}
            {tablet && railOpen && (
              <div
                className="absolute inset-y-0 start-0 z-(--z-sidebar) shadow-lg animate-fade-in"
                data-testid="rail-expanded"
              >
                {renderSidebar({
                  collapsed: false,
                  onToggleCollapsed: () => setRailOpen(false),
                  inDrawer: false,
                })}
              </div>
            )}
          </div>
          {/* Relative, as on phones: absolutely positioned content must not grow the document. */}
          <main className="relative flex min-w-0 flex-1 flex-col overflow-y-auto">{children}</main>
          <CheatSheet />
          <PaletteHost />
        </div>
      </ShellContext.Provider>
    </LiveInbox>
  );
}

export interface ViewHeaderProps {
  title: string;
  /** Muted context after the title, e.g. the org name (02 §2). */
  context?: string | undefined;
  actions?: ReactNode;
  /**
   * Phones (02 §13.1): `switcher` shows the org switcher and the view switcher instead of the
   * title; `actions` replace the desktop actions; `menu` adds screen items to the ⋯ menu.
   */
  mobile?:
    | {
        switcher?: boolean;
        actions?: ReactNode;
        menu?: ReactNode;
        views?: readonly ViewTab[];
        /** A drilled-in screen: "‹ label" back to `href` (Settings → a section). */
        back?: { href: string; label: string };
        /** The phone title when it differs from `title`, e.g. the section drilled into. */
        title?: string;
      }
    | undefined;
}

/** The main-area header: view title and org name; the phone header below 768 px. */
export function ViewHeader({ title, context, actions, mobile }: ViewHeaderProps) {
  const shell = useContext(ShellContext);
  const isMobile = useIsMobile();
  if (isMobile && shell?.mobile) {
    return (
      <MobileHeader
        title={mobile?.title ?? title}
        context={context}
        org={mobile?.switcher ? shell.mobile.activeOrg : null}
        onOpenOrgs={shell.openOrgs}
        actions={mobile?.actions}
        views={mobile?.views}
        back={mobile?.back}
        menu={<ShellMenuItems shell={shell.mobile} extra={mobile?.menu} />}
      />
    );
  }
  return (
    <header className="sticky top-0 z-(--z-sticky) bg-bg-app">
      <div className="mx-auto flex h-sheet-header w-full max-w-list-max items-center gap-2 px-3 tablet:px-6 desktop:px-8">
        <h1 className="flex min-w-0 flex-1 items-baseline gap-2 text-lg">
          <span className="truncate">{title}</span>
          {context && (
            <span className="truncate text-sm font-normal tracking-normal text-text-muted">
              {context}
            </span>
          )}
        </h1>
        <SyncStatus className="max-tablet:hidden" />
        {actions}
      </div>
    </header>
  );
}

/** The phone's ⋯ menu: the screen's items, then org settings, admin and sign out. */
function ShellMenuItems({ shell, extra }: { shell: MobileShell; extra?: ReactNode }) {
  const { t } = useTranslation('shell');
  const org = shell.activeOrg;
  return (
    <>
      {extra}
      {extra && <MenuSeparator />}
      {org && (
        <MenuItem icon={Settings} href={paths.orgSettings(orgUrlSlug(org))}>
          {t('org.settings')}
        </MenuItem>
      )}
      {shell.isAdmin && (
        <MenuItem icon={ShieldCheck} href={paths.admin}>
          {t('user.admin')}
        </MenuItem>
      )}
      <MenuItem icon={LogOut} onAction={shell.onSignOut}>
        {t('user.signOut')}
      </MenuItem>
    </>
  );
}

/** The centred content column under a ViewHeader (list max width and 02 §2 gutters). */
export function ViewBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'mx-auto flex w-full max-w-list-max flex-col px-3 pt-2 pb-16 tablet:px-6 desktop:px-8',
        className,
      )}
    >
      {children}
    </div>
  );
}
