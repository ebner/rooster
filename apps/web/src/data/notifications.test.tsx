import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fixtureNotifications } from '../features/collab/fixtures';
import {
  type NotificationPages,
  setUnreadCount,
  useMarkNotifications,
  useUnreadCount,
} from './notifications';
import { queryKeys } from './query-keys';

const items = fixtureNotifications(1_800_000_000_000);

const api = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn(), PUT: vi.fn() }));
vi.mock('./http', async (original) => ({ ...(await original<typeof import('./http')>()), api }));

const ok = (data: unknown) => ({ data, response: new Response(null, { status: 200 }) });
const failed = () => ({
  error: { code: 'internal' },
  response: new Response(null, { status: 500 }),
});

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const data: NotificationPages = {
    pages: [{ items, nextCursor: null, unreadCount: 2 }],
    pageParams: [null],
  };
  queryClient.setQueryData(queryKeys.notifications('all'), data);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const page = () =>
    queryClient.getQueryData<NotificationPages>(queryKeys.notifications('all'))?.pages[0];
  return { queryClient, wrapper, page };
}

afterEach(() => vi.resetAllMocks());

describe('notifications cache', () => {
  test('setUnreadCount writes the SSE count into every cached page (no refetch)', async () => {
    const { queryClient, wrapper, page } = setup();
    const { result } = renderHook(() => useUnreadCount(), { wrapper });
    expect(result.current).toBe(2);
    act(() => setUnreadCount(queryClient, 5));
    expect(page()?.unreadCount).toBe(5);
    await vi.waitFor(() => expect(result.current).toBe(5));
    expect(api.GET).not.toHaveBeenCalled();
  });

  test('marking read is optimistic; the server count wins; a failure rolls back', async () => {
    const { wrapper, page } = setup();
    api.POST.mockResolvedValueOnce(ok({ unreadCount: 7 })).mockResolvedValueOnce(failed());
    const { result } = renderHook(() => useMarkNotifications(), { wrapper });
    const unread = items[0];
    if (!unread) throw new Error('fixture');

    const pending = act(() => result.current.mutateAsync({ read: true, ids: [unread.id] }));
    await pending;
    expect(page()?.items[0]?.readAt).not.toBeNull();
    expect(page()?.unreadCount).toBe(7);

    await act(async () => {
      await result.current.mutateAsync({ read: false, ids: [unread.id] }).catch(() => undefined);
    });
    expect(page()?.items[0]?.readAt).not.toBeNull();
    expect(page()?.unreadCount).toBe(7);
  });

  test('mark all read zeroes the count at once', async () => {
    const { wrapper, page } = setup();
    let resolve: (r: unknown) => void = () => undefined;
    api.POST.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const { result } = renderHook(() => useMarkNotifications(), { wrapper });
    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = result.current.mutateAsync({ read: true, all: true });
    });
    await vi.waitFor(() => expect(page()?.unreadCount).toBe(0));
    expect(page()?.items.every((n) => n.readAt !== null)).toBe(true);
    resolve(ok({ unreadCount: 0 }));
    await act(async () => {
      await done;
    });
  });
});
