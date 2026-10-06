import type { ListState } from '@rooster/core/reducers';
import { type ViewCounts, viewCounts } from '@rooster/core/views';
import { createContext, type ReactNode, useCallback, useContext, useMemo } from 'react';
import { useMyListSelect } from '../../data/list';
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
      <OrgCountsContext.Provider value={useLiveOrgCounts}>{children}</OrgCountsContext.Provider>
    </CountsClockContext.Provider>
  );
}
