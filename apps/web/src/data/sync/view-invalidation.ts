import type { QueryClient } from '@tanstack/react-query';
import { isViewTasksData } from '../pipeline/view-tasks-ops';

/**
 * Phase 13 (ADR 0073 B): task changes carry no key of their own for views. The server's task
 * keys stand in: `['everyone', orgId]` (every member of a shared org, every task change there)
 * and `['my-list', orgId]` (a personal org) also refetch the org's views (`['views', orgId]`,
 * the sidebar counts) and every view's rows of that org; `['task', id]` refetches the rows of
 * the views holding that task (comment and attachment counts). `['views', orgId]` (a view
 * changed, by someone else: this tab's own changes don't come here) refetches the org's rows.
 */
export function invalidateViewsFor(queryClient: QueryClient, key: readonly string[]): void {
  const [root, id] = key;
  if (typeof id !== 'string') return;
  if (root === 'views') {
    // Someone changed a view of the org (its query, perhaps): the rows' keys name only the
    // view, so they are fetched again.
    void queryClient.invalidateQueries({
      queryKey: ['view-tasks'],
      predicate: (query) => {
        const data = query.state.data;
        return isViewTasksData(data) ? data.orgId === id : query.meta?.orgId === id;
      },
    });
  } else if (root === 'everyone' || root === 'my-list') {
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

/**
 * A view gone from its org's live list (deleted, archived, unshared, by anyone) takes its rows'
 * caches with it, so they neither linger in memory nor in the persisted cache. Returns the
 * unsubscribe.
 */
export function dropGoneViewCaches(queryClient: QueryClient): () => void {
  return queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success') return;
    const [root, orgId, which] = event.query.queryKey;
    if (root !== 'views' || which !== 'live' || typeof orgId !== 'string') return;
    const live = event.query.state.data;
    if (!Array.isArray(live)) return;
    const ids = new Set(live.map((view: { id?: unknown }) => view.id));
    queryClient.removeQueries({
      queryKey: ['view-tasks'],
      predicate: (query) => {
        const data = query.state.data;
        return isViewTasksData(data) && data.orgId === orgId && !ids.has(query.queryKey[1]);
      },
    });
  });
}
