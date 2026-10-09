import type { ActivityFilter } from '@rooster/core/schemas';
import { useCallback, useState } from 'react';
import { userStorageKey } from '../../lib/user-storage';

const storageName = 'activity-filter';

function read(userId: string): ActivityFilter {
  try {
    const stored = globalThis.localStorage?.getItem(userStorageKey(userId, storageName));
    return stored === 'comments' ? 'comments' : 'all';
  } catch {
    return 'all';
  }
}

/**
 * The pane's "Comments only / All activity" toggle (02 §9.2 item 8), remembered per user on
 * this device: a reader who only wants the conversation keeps it for every task.
 */
export function useActivityFilter(
  userId: string,
): [ActivityFilter, (filter: ActivityFilter) => void] {
  const [filter, setFilter] = useState(() => read(userId));
  const update = useCallback(
    (next: ActivityFilter) => {
      setFilter(next);
      try {
        globalThis.localStorage?.setItem(userStorageKey(userId, storageName), next);
      } catch {
        // Storage blocked: the choice holds for this pane.
      }
    },
    [userId],
  );
  return [filter, update];
}
