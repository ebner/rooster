import type { SavedView } from '@rooster/core/schemas';
import type { QueryClient } from '@tanstack/react-query';
import { queryKeys } from '../../data/query-keys';
import type { Me } from '../../data/types';

/**
 * Whether a late answer may still write an org's views into the caches: the session that sent
 * it is the current one (`sessionScope`), and the user is still a member of the org (a fresh
 * `/me` prunes a left org's caches; a write after that would bring them back, and persist them).
 */
export function mayWriteViews(
  queryClient: QueryClient,
  orgId: string,
  session: { stale: () => boolean },
): boolean {
  if (session.stale()) return false;
  const me = queryClient.getQueryData<Me>(queryKeys.me);
  return Boolean(me?.orgs.some((org) => org.id === orgId));
}

/**
 * A view just created, into its org's live list when that is cached (never a new list: one
 * not cached is fetched with the view in it), so the screen it opens never shows "not found".
 */
export function addCreatedView(queryClient: QueryClient, created: SavedView): void {
  queryClient.setQueryData<SavedView[]>(queryKeys.views(created.orgId, false), (list) =>
    !list || list.some((v) => v.id === created.id) ? list : [...list, created],
  );
}
