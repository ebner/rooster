import type { QueryClient } from '@tanstack/react-query';
import { isViewTasksData } from '../pipeline/view-tasks-ops';

/**
 * Phase 13 (ADR 0073 B): task changes carry no key of their own for views. The server's task
 * keys stand in: `['everyone', orgId]` (every member of a shared org, every task change there)
 * and `['my-list', orgId]` (a personal org) also refetch the org's views (`['views', orgId]`,
 * the sidebar counts) and every view's rows of that org; `['task', id]` refetches the rows of
 * the views holding that task (comment and attachment counts).
 */
export function invalidateViewsFor(queryClient: QueryClient, key: readonly string[]): void {
  const [root, id] = key;
  if (typeof id !== 'string') return;
  if (root === 'everyone' || root === 'my-list') {
    void queryClient.invalidateQueries({ queryKey: ['views', id] });
    void queryClient.invalidateQueries({
      queryKey: ['view-tasks'],
      predicate: (query) => {
        const data = query.state.data;
        return !isViewTasksData(data) || data.orgId === id;
      },
    });
  } else if (root === 'task') {
    void queryClient.invalidateQueries({
      queryKey: ['view-tasks'],
      predicate: (query) => {
        const data = query.state.data;
        return isViewTasksData(data) && data.items.some((task) => task.id === id);
      },
    });
  }
}
