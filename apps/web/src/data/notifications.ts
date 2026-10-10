import type {
  Notification,
  NotificationMark,
  NotificationMarkResult,
  NotificationPage,
  NotificationPref,
  Prefs,
} from '@rooster/core/schemas';
import {
  type InfiniteData,
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect } from 'react';
import { api, unwrap } from './http';
import { toMe } from './mappers';
import { queryKeys } from './query-keys';
import { sessionScope } from './session-events';
import { subscribeSseNotifications } from './sync/events';
import type { Me, MutationResult, QueryResult } from './types';

export type NotificationFilter = 'all' | 'unread';
export type NotificationPages = InfiniteData<NotificationPage, string | null>;

export const notificationPageSize = 30;

function fetchPage(filter: NotificationFilter, cursor: string | null): Promise<NotificationPage> {
  return unwrap(
    api.GET('/api/v1/notifications', {
      params: {
        query: {
          limit: notificationPageSize,
          ...(filter === 'unread' ? { unread: 'true' as const } : {}),
          ...(cursor ? { cursor } : {}),
        },
      },
    }),
  );
}

const pagesOptions = (filter: NotificationFilter) => ({
  queryKey: queryKeys.notifications(filter),
  queryFn: ({ pageParam }: { pageParam: string | null }) => fetchPage(filter, pageParam),
  initialPageParam: null as string | null,
  getNextPageParam: (page: NotificationPage) => page.nextCursor,
  staleTime: 30_000,
});

export interface NotificationsResult {
  /** Newest first, every loaded page. */
  items: Notification[] | undefined;
  unreadCount: number | undefined;
  isPending: boolean;
  error: Error | null;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
}

/**
 * `GET /notifications` (06 §2.6, FR-NOT-1): the cross-org inbox, newest first. The first page
 * of `['notifications', 'all']` is persisted (04 §6.1), so the inbox and its badge read offline.
 */
export function useNotifications(filter: NotificationFilter): NotificationsResult {
  const query = useInfiniteQuery(pagesOptions(filter));
  return {
    items: query.data?.pages.flatMap((page) => page.items),
    unreadCount: query.data?.pages[0]?.unreadCount,
    isPending: query.isPending,
    error: query.error,
    hasMore: query.hasNextPage,
    isLoadingMore: query.isFetchingNextPage,
    loadMore: () => void query.fetchNextPage(),
  };
}

/**
 * The unread badge (sidebar Inbox, phone bottom nav): the count the server sends with every
 * page. It shares the inbox's `['notifications', 'all']` cache, and the SSE `notification`
 * event writes the new count into it directly (`setUnreadCount`), so the badge never waits
 * for a refetch.
 */
export function useUnreadCount(enabled = true): number | undefined {
  const query = useInfiniteQuery({
    ...pagesOptions('all'),
    select: (data: NotificationPages) => data.pages[0]?.unreadCount ?? 0,
    enabled,
  });
  return query.data;
}

function mapPages(
  queryClient: QueryClient,
  map: (page: NotificationPage) => NotificationPage,
): void {
  queryClient.setQueriesData<NotificationPages>({ queryKey: ['notifications'] }, (data) =>
    data ? { ...data, pages: data.pages.map(map) } : data,
  );
}

/** Writes the authoritative unread count into every cached inbox page. */
export function setUnreadCount(queryClient: QueryClient, unreadCount: number): void {
  mapPages(queryClient, (page) =>
    page.unreadCount === unreadCount ? page : { ...page, unreadCount },
  );
}

/**
 * Keeps the badge live: the SSE `notification` event (04 §4.5) carries the unread count, which
 * goes straight into the cache; the stream itself invalidates `['notifications']` for the list.
 * Mounted once by the signed-in frame.
 */
export function useNotificationStream(): void {
  const queryClient = useQueryClient();
  useEffect(
    () => subscribeSseNotifications((event) => setUnreadCount(queryClient, event.unreadCount)),
    [queryClient],
  );
}

export type MarkNotificationsInput = { read: boolean } & NotificationMark;

/** The optimistic `readAt` of one item; `all` marks every loaded item. */
function markedPage(page: NotificationPage, input: MarkNotificationsInput, now: number) {
  const ids = 'ids' in input ? new Set(input.ids) : null;
  let delta = 0;
  const items = page.items.map((item) => {
    if (ids && !ids.has(item.id)) return item;
    if (input.read === (item.readAt !== null)) return item;
    delta += input.read ? -1 : 1;
    return { ...item, readAt: input.read ? now : null };
  });
  return { items, delta };
}

/**
 * `POST /notifications/read` and `/notifications/unread` (06 §2.6). Online-only (ADR 0028),
 * with an optimistic cache update; the response's unread count is authoritative.
 */
export function useMarkNotifications(): MutationResult<
  MarkNotificationsInput,
  NotificationMarkResult
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ read, ...mark }: MarkNotificationsInput): Promise<NotificationMarkResult> =>
      unwrap(
        read
          ? api.POST('/api/v1/notifications/read', { body: mark })
          : api.POST('/api/v1/notifications/unread', { body: mark }),
      ),
    onMutate: async (input) => {
      const session = sessionScope();
      await queryClient.cancelQueries({ queryKey: ['notifications'] });
      const before = queryClient.getQueriesData<NotificationPages>({ queryKey: ['notifications'] });
      const now = Date.now();
      // The badge follows the items of the `all` list (the unread list holds a subset).
      const all = queryClient.getQueryData<NotificationPages>(queryKeys.notifications('all'));
      const delta = (all?.pages ?? []).reduce(
        (sum, page) => sum + markedPage(page, input, now).delta,
        0,
      );
      queryClient.setQueriesData<NotificationPages>({ queryKey: ['notifications'] }, (data) => {
        if (!data) return data;
        const first = data.pages[0];
        const count =
          'all' in input && input.read ? 0 : Math.max(0, (first?.unreadCount ?? 0) + delta);
        return {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: markedPage(page, input, now).items,
            unreadCount: count,
          })),
        };
      });
      return { before, session };
    },
    onError: (_error, _input, context) => {
      // A sign-out or lost session meanwhile cleared the inbox: it must not come back.
      if (!context || context.session.stale()) return;
      for (const [key, data] of context.before) queryClient.setQueryData(key, data);
    },
    onSuccess: (result) => setUnreadCount(queryClient, result.unreadCount),
  });
}

/** `GET /me/notification-prefs` (FR-NOT-4): every event × channel cell, defaults applied. */
export function useNotificationPrefs(): QueryResult<NotificationPref[]> {
  return useQuery({
    queryKey: queryKeys.notificationPrefs,
    queryFn: async () => (await unwrap(api.GET('/api/v1/me/notification-prefs'))).prefs,
  });
}

/** `PUT /me/notification-prefs` with the changed cells. Online-only settings (hard rule 4). */
export function useUpdateNotificationPrefs(): MutationResult<
  NotificationPref[],
  NotificationPref[]
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (prefs: NotificationPref[]) =>
      (await unwrap(api.PUT('/api/v1/me/notification-prefs', { body: { prefs } }))).prefs,
    onMutate: async (cells) => {
      const session = sessionScope();
      await queryClient.cancelQueries({ queryKey: queryKeys.notificationPrefs });
      const before = queryClient.getQueryData<NotificationPref[]>(queryKeys.notificationPrefs);
      queryClient.setQueryData<NotificationPref[]>(queryKeys.notificationPrefs, (current) =>
        current?.map(
          (cell) => cells.find((c) => c.type === cell.type && c.channel === cell.channel) ?? cell,
        ),
      );
      return { before, session };
    },
    onError: (_error, _cells, context) => {
      if (!context || context.session.stale()) return;
      queryClient.setQueryData(queryKeys.notificationPrefs, context.before);
    },
    onSuccess: (prefs, _cells, context) => {
      if (!context.session.stale()) queryClient.setQueryData(queryKeys.notificationPrefs, prefs);
    },
  });
}

/** The `user.prefs` keys of Settings → Notifications (FR-NOT-2/3). */
export type DeliveryPrefs = Pick<
  Prefs,
  'reminderTime' | 'digestTime' | 'emailMode' | 'allDayReminderTime'
>;

/**
 * `PATCH /me` `{prefs}` for the reminder, all-day reminder and digest times and the email mode: optimistic on
 * the cached `/me`, rolled back on failure. Online-only settings (hard rule 4).
 */
export function useUpdateDeliveryPrefs(): MutationResult<Partial<DeliveryPrefs>> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (prefs: Partial<DeliveryPrefs>) => {
      const session = sessionScope();
      const me = await unwrap(api.PATCH('/api/v1/me', { body: { prefs } }));
      // The session may have ended meanwhile (a 401, sign-out, another account): a profile
      // written back now would count as signed in again (ADR 0051).
      if (!session.stale()) queryClient.setQueryData(queryKeys.me, toMe(me));
    },
    onMutate: async (patch) => {
      const session = sessionScope();
      await queryClient.cancelQueries({ queryKey: queryKeys.me });
      const before = queryClient.getQueryData<Me>(queryKeys.me);
      if (before?.prefs) {
        queryClient.setQueryData<Me>(queryKeys.me, {
          ...before,
          prefs: { ...before.prefs, ...patch },
        });
      }
      return { before, session };
    },
    onError: (_error, _patch, context) => {
      if (context?.before && !context.session.stale()) {
        queryClient.setQueryData(queryKeys.me, context.before);
      }
    },
  });
}
