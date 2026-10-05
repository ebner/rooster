import { Menu as MenuIcon } from 'lucide-react';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { Dialog, Modal, ModalOverlay } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { keymap, matchesShortcut } from '../../keymap';
import { cn } from '../../lib/cn';
import { detectPlatform } from '../../lib/platform';
import { IconButton } from '../../ui/icon-button';
import { useSidebarCollapsed } from './use-sidebar-collapsed';

export interface ShellSidebarState {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** True for the off-canvas copy rendered in the mobile drawer. */
  inDrawer: boolean;
}

interface ShellContextValue {
  openNav: () => void;
}

const ShellContext = createContext<ShellContextValue | null>(null);

export interface AppShellProps {
  /** Rendered twice: inline (tablet and up) and in the mobile drawer when it is open. */
  renderSidebar: (state: ShellSidebarState) => ReactNode;
  children: ReactNode;
  /** Closes the mobile drawer whenever this changes (e.g. the pathname). */
  navKey?: string | undefined;
}

/**
 * The app frame (02 §2): sidebar + main. The rail state is persisted and toggled
 * with Mod+\ (02 §6). Below 768 px the sidebar becomes an off-canvas drawer opened
 * from the view header; the full mobile frame (bottom nav, org switcher) is P4.
 */
export function AppShell({ renderSidebar, children, navKey }: AppShellProps) {
  const { t } = useTranslation('shell');
  const [collapsed, toggleCollapsed] = useSidebarCollapsed();
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    const platform = detectPlatform();
    const onKeyDown = (event: KeyboardEvent) => {
      if (matchesShortcut(event, keymap.toggleSidebar.keys, platform)) {
        event.preventDefault();
        toggleCollapsed();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleCollapsed]);

  useEffect(() => setNavOpen(false), [navKey]);

  const context = useMemo(() => ({ openNav: () => setNavOpen(true) }), []);

  return (
    <ShellContext.Provider value={context}>
      <div className="flex h-dvh overflow-hidden bg-bg-app">
        <div className="relative z-(--z-sidebar) hidden shrink-0 border-e border-border tablet:block">
          {renderSidebar({ collapsed, onToggleCollapsed: toggleCollapsed, inDrawer: false })}
        </div>
        <ModalOverlay
          isOpen={navOpen}
          onOpenChange={setNavOpen}
          isDismissable
          className="fixed inset-0 z-(--z-sidebar) bg-overlay data-entering:animate-fade-in tablet:hidden"
        >
          <Modal className="h-full w-sidebar max-w-full shadow-lg">
            <Dialog aria-label={t('sidebar.label')} className="h-full outline-none">
              {renderSidebar({
                collapsed: false,
                onToggleCollapsed: toggleCollapsed,
                inDrawer: true,
              })}
            </Dialog>
          </Modal>
        </ModalOverlay>
        <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">{children}</main>
      </div>
    </ShellContext.Provider>
  );
}

export interface ViewHeaderProps {
  title: string;
  /** Muted context after the title, e.g. the org name (02 §2). */
  context?: string | undefined;
  actions?: ReactNode;
}

/** The main-area header: view title, org name, and the drawer button on phones. */
export function ViewHeader({ title, context, actions }: ViewHeaderProps) {
  const { t } = useTranslation('shell');
  const shell = useContext(ShellContext);
  return (
    <header className="sticky top-0 z-(--z-sticky) bg-bg-app">
      <div className="mx-auto flex h-sheet-header w-full max-w-list-max items-center gap-2 px-3 tablet:px-6 desktop:px-8">
        {shell && (
          <IconButton
            icon={MenuIcon}
            aria-label={t('sidebar.open')}
            onPress={shell.openNav}
            className="-ms-1.5 tablet:hidden"
          />
        )}
        <h1 className="flex min-w-0 flex-1 items-baseline gap-2 text-lg">
          <span className="truncate">{title}</span>
          {context && (
            <span className="truncate text-sm font-normal tracking-normal text-text-muted">
              {context}
            </span>
          )}
        </h1>
        {actions}
      </div>
    </header>
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
