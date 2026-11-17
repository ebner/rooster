import type { ListState } from '@rooster/core/reducers';
import {
  type AllView,
  type AllViewSource,
  allViewCounts,
  type ViewCounts,
  viewCounts,
} from '@rooster/core/views';
import { type QueryObserverResult, useQueries } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useMemo } from 'react';
import { myListKey, useListPipeline, useMyListSelect } from '../../data/list';
import { useMe } from '../../data/me';
import { useViewerDateContext } from '../dates';
import type { OrgViewId } from '../shell/paths';

export type OrgCounts = Partial<Record<OrgViewId, number>>;

/** The sidebar badges (02 §2): My tasks and Today counts, Overdue in danger; none for the rest. */
export function badgeCounts(counts: ViewCounts): OrgCounts {
  return { my: counts.my, today: counts.today, overdue: counts.overdue };
}

interface CountsClock {
  viewerId: string;
  today: string;
  nowMs: number;
  viewerTz: string;
}

const CountsClockContext = createContext<CountsClock | null>(null);

/**
 * One org's badges from its cached list (`['my-list', orgId]`, prefetched for every org). The
 * selector reruns only when that org's list state or the minute changes, and the result is
 * structurally shared, so a badge re-renders only when a count changes, never the list.
 */
function useLiveOrgCounts(orgId: string): OrgCounts | undefined {
  const clock = useContext(CountsClockContext);
  const select = useCallback(
    (state: ListState): OrgCounts => (clock ? badgeCounts(viewCounts(state, clock)) : {}),
    [clock],
  );
  return useMyListSelect(orgId, select).data;
}

type UseOrgCounts = (orgId: string) => OrgCounts | undefined;

/**
 * How a sidebar section gets its badges. Outside the app (tests, the kitchen sink) there are
 * none; `LiveViewCounts` supplies the live hook. The value never changes while mounted, so
 * the hook order of its callers stays fixed.
 */
const OrgCountsContext = createContext<UseOrgCounts>(() => undefined);

export function useOrgCountsHook(): UseOrgCounts {
  return useContext(OrgCountsContext);
}

/** All organisations' badges (ADR 0073 A5): every org's counts, summed. */
export type AllCounts = Pick<ViewCounts, AllView>;

/**
 * The summed badges from every org's cached list, in sidebar order (`['my-list', orgId]`,
 * prefetched for every org by the sync engine). The combined result is structurally shared,
 * so a badge re-renders only when a sum changes. Undefined until a list is cached.
 */
function useLiveAllCounts(): AllCounts | undefined {
  const clock = useContext(CountsClockContext);
  const pipeline = useListPipeline();
  // Stable while the orgs and their order stay: a new `/me` alone doesn't rebuild `combine`.
  const key =
    useMe()
      .data?.orgs.map((org) => org.id)
      .join(',') ?? '';
  const orgIds = useMemo(() => (key ? key.split(',') : []), [key]);
  const combine = useCallback(
    (results: QueryObserverResult<ListState>[]): AllCounts | undefined => {
      if (!clock) return undefined;
      const sources: AllViewSource[] = [];
      results.forEach((result, index) => {
        const orgId = orgIds[index];
        if (result.data && orgId) sources.push({ orgId, source: result.data });
      });
      return sources.length > 0 ? allViewCounts(sources, clock) : undefined;
    },
    [clock, orgIds],
  );
  return useQueries({
    queries: orgIds.map((orgId) => ({
      queryKey: myListKey(orgId),
      queryFn: () => pipeline.fetch(orgId),
      staleTime: 30_000,
      refetchOnWindowFocus: true,
    })),
    combine,
  });
}

/**
 * How the sidebar's All organisations section (and the phone) get the summed badges; none
 * outside the app (tests, the kitchen sink), as for `OrgCountsContext`.
 */
const AllCountsContext = createContext<() => AllCounts | undefined>(() => undefined);

/** All organisations' badges: Today, Next 7 days and Overdue summed over every org. */
export function useAllViewCounts(): AllCounts | undefined {
  return useContext(AllCountsContext)();
}

/** Provides live sidebar badges for every org (the signed-in layout). */
export function LiveViewCounts({ children }: { children: ReactNode }) {
  const viewerId = useMe().data?.user.id;
  const date = useViewerDateContext();
  const clock = useMemo<CountsClock | null>(
    () =>
      viewerId ? { viewerId, today: date.today, nowMs: date.nowMs, viewerTz: date.timezone } : null,
    [viewerId, date.today, date.nowMs, date.timezone],
  );
  return (
    <CountsClockContext.Provider value={clock}>
      <OrgCountsContext.Provider value={useLiveOrgCounts}>
        <AllCountsContext.Provider value={useLiveAllCounts}>{children}</AllCountsContext.Provider>
      </OrgCountsContext.Provider>
    </CountsClockContext.Provider>
  );
}
