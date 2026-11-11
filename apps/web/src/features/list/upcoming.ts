import { diffDays, formatRelative } from '@rooster/core/dates';
import type { Task } from '@rooster/core/schemas';
import { upcomingDay } from '@rooster/core/upcoming';
import { useMemo } from 'react';
import { create } from 'zustand';
import { onSessionDataCleared } from '../../data/session-events';
import { userStorageKey } from '../../lib/user-storage';
import type { ViewerDateContext } from '../dates/types';

/**
 * The Upcoming section of My tasks (ADR 0068). It is folded unless the user opened it; the
 * open state is kept per user and org on this device (`userStorageKey`, swept on sign-out).
 */

const storageName = (orgId: string) => `list.upcomingOpen.${orgId}`;
const cacheKey = (userId: string, orgId: string) => `${userId}|${orgId}`;

/** Changes made this session, over what storage said when the list was first shown. */
const useUpcomingStore = create<{ open: Readonly<Record<string, boolean>> }>()(() => ({
  open: {},
}));

onSessionDataCleared(() => useUpcomingStore.setState({ open: {} }));

function readOpen(userId: string, orgId: string): boolean {
  try {
    return globalThis.localStorage?.getItem(userStorageKey(userId, storageName(orgId))) === '1';
  } catch {
    return false;
  }
}

export function upcomingOpen(userId: string, orgId: string): boolean {
  return useUpcomingStore.getState().open[cacheKey(userId, orgId)] ?? readOpen(userId, orgId);
}

export function setUpcomingOpen(userId: string, orgId: string, open: boolean): void {
  useUpcomingStore.setState((s) => ({ open: { ...s.open, [cacheKey(userId, orgId)]: open } }));
  try {
    const key = userStorageKey(userId, storageName(orgId));
    if (open) globalThis.localStorage?.setItem(key, '1');
    else globalThis.localStorage?.removeItem(key);
  } catch {
    // Blocked storage: the section stays open for this session only.
  }
}

/** Whether the section is open; storage is read once per user and org, not per render. */
export function useUpcomingOpen(userId: string, orgId: string): boolean {
  const stored = useMemo(() => readOpen(userId, orgId), [userId, orgId]);
  const changed = useUpcomingStore((s) => s.open[cacheKey(userId, orgId)]);
  return changed ?? stored;
}

/**
 * The day an upcoming task returns to its group, as its row's date cell names it ("Tomorrow",
 * "Mon", "Nov 23"). `inline` lowercases the near labels for use mid-sentence, as row names do.
 */
export function upcomingDayLabel(
  task: Pick<Task, 'startDate' | 'dueDate'>,
  ctx: Pick<ViewerDateContext, 'today' | 'locale' | 'dateFormat' | 'timeFormat'>,
  inline = false,
): string {
  const day = upcomingDay(task);
  if (day === null) return '';
  const label = formatRelative({ dueDate: day }, ctx);
  return inline && Math.abs(diffDays(day, ctx.today)) <= 1
    ? label.charAt(0).toLocaleLowerCase(ctx.locale) + label.slice(1)
    : label;
}
