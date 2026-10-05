import { useLocation } from '@tanstack/react-router';
import { useEffect } from 'react';
import { findOrg, useMe } from '../../data';

/** 02 §12: the palette's empty state lists the last 8 opened tasks. */
export const recentTasksMax = 8;

export interface RecentTask {
  id: string;
  orgId: string;
  /** The title when last seen; the palette prefers the cached task's current title. */
  title: string;
  /** When it was opened (ms epoch). */
  at: number;
}

const storageKey = (userId: string) => `rooster.palette.recent.${userId}`;

/** Per device and user (localStorage). Unavailable or corrupt storage reads as empty. */
export function readRecentTasks(userId: string): RecentTask[] {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey(userId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is RecentTask =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof entry.id === 'string' &&
          typeof entry.orgId === 'string' &&
          typeof entry.title === 'string' &&
          typeof entry.at === 'number',
      )
      .slice(0, recentTasksMax);
  } catch {
    return [];
  }
}

function writeRecentTasks(userId: string, entries: readonly RecentTask[]): void {
  try {
    globalThis.localStorage?.setItem(
      storageKey(userId),
      JSON.stringify(entries.slice(0, recentTasksMax)),
    );
  } catch {
    // Private mode or a full quota: recents are a convenience.
  }
}

/** Moves `entry` to the front (most recent first); a known title survives an unknown one. */
export function recordRecentTask(userId: string, entry: RecentTask): RecentTask[] {
  const previous = readRecentTasks(userId);
  const old = previous.find((e) => e.id === entry.id);
  const next = [
    { ...entry, title: entry.title || old?.title || '' },
    ...previous.filter((e) => e.id !== entry.id),
  ].slice(0, recentTasksMax);
  writeRecentTasks(userId, next);
  return next;
}

/** Stores titles the palette resolved from the cache, so they survive a cold start. */
export function updateRecentTitles(userId: string, titles: ReadonlyMap<string, string>): void {
  const entries = readRecentTasks(userId);
  let changed = false;
  const next = entries.map((entry) => {
    const title = titles.get(entry.id);
    if (title === undefined || title === entry.title) return entry;
    changed = true;
    return { ...entry, title };
  });
  if (changed) writeRecentTasks(userId, next);
}

export function forgetRecentTask(userId: string, taskId: string): void {
  writeRecentTasks(
    userId,
    readRecentTasks(userId).filter((e) => e.id !== taskId),
  );
}

const taskPath = /^\/o\/([^/]+)\/t\/([^/]+)\/?$/;

/**
 * Records every task the detail pane opens (its URL is `/o/:slug/t/:taskId`, 02 §2), so the
 * palette does not depend on the pane. Mounted once in the app shell.
 */
export function useRecentTaskRecorder(): void {
  const { pathname } = useLocation();
  const me = useMe().data;
  useEffect(() => {
    const match = taskPath.exec(pathname);
    if (!match || !me) return;
    const org = findOrg(me.orgs, decodeURIComponent(match[1] ?? ''));
    const taskId = decodeURIComponent(match[2] ?? '');
    if (!org || !taskId) return;
    recordRecentTask(me.user.id, { id: taskId, orgId: org.id, title: '', at: Date.now() });
  }, [pathname, me]);
}
