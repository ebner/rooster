import { QueryClientContext } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { createContext, type ReactNode, useContext } from 'react';
import { useNotificationStream, useUnreadCount } from '../../data/notifications';
import { paths } from '../shell/paths';

/** What the Inbox entries (sidebar item, phone bottom-nav tab) show. */
export interface InboxNavState {
  /** Unread notifications across every org; undefined until known. */
  unread: number | undefined;
  /** `/inbox` is the current page. */
  active: boolean;
}

type UseInboxNav = () => InboxNavState;

const idle: InboxNavState = { unread: undefined, active: false };

/**
 * How the shell's Inbox entries get their state. Outside the signed-in app (tests, the kitchen
 * sink) there is no badge; `LiveInbox` supplies the live hook. The value never changes while
 * mounted, so the hook order of its callers stays fixed.
 */
const InboxNavContext = createContext<UseInboxNav>(() => idle);

export function useInboxNav(): InboxNavState {
  return useContext(InboxNavContext)();
}

function useLiveInboxNav(): InboxNavState {
  const unread = useUnreadCount();
  const active = useRouterState({ select: (s) => s.location.pathname === paths.inbox });
  return { unread, active };
}

function LiveInboxProvider({ children }: { children: ReactNode }) {
  useNotificationStream();
  return <InboxNavContext.Provider value={useLiveInboxNav}>{children}</InboxNavContext.Provider>;
}

/**
 * The live unread badge (FR-NOT-1): counts from the inbox cache, kept current by the SSE
 * `notification` event. Mounted by the app frame; a frame without a query client (unit tests
 * of the shell) renders without it.
 */
export function LiveInbox({ children }: { children: ReactNode }) {
  const client = useContext(QueryClientContext);
  return client ? <LiveInboxProvider>{children}</LiveInboxProvider> : children;
}

/** Fixed Inbox state for the kitchen sink and tests. */
export function StaticInboxNav({ state, children }: { state: InboxNavState; children: ReactNode }) {
  return <InboxNavContext.Provider value={() => state}>{children}</InboxNavContext.Provider>;
}
