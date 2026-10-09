import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const http = vi.hoisted(() => ({ GET: vi.fn() }));
vi.mock('./http', async (original) => ({
  ...(await original<typeof import('./http')>()),
  api: http,
}));

const { confirmGrantOrgs, useConfirmedGrantOrgs } = await import('./grants');

const orgA = '0192f5d0-7a1e-7c3a-9f10-0000000000a1';
const me = {
  user: {
    id: 'u1',
    name: 'U',
    email: 'u@example.com',
    image: null,
    isAdmin: false,
    locale: 'en',
    timezone: 'UTC',
    weekStart: 1,
    dateFormat: 'MMM d',
    timeFormat: '24h',
  },
  orgs: [{ id: orgA, slug: 'personal', name: 'Personal', isPersonal: true, role: 'owner' }],
};
const ok = (data: unknown) =>
  Promise.resolve({ data, response: new Response(null, { status: 200 }) });
let groups = [{ id: 'g1', name: 'Inbox', kind: 'inbox' }];

beforeEach(() => {
  groups = [{ id: 'g1', name: 'Inbox', kind: 'inbox' }];
  http.GET.mockImplementation((path: string) =>
    path === '/api/v1/me' ? ok(me) : ok({ groups, tasks: [], expandedTaskIds: [], serverTime: 0 }),
  );
});

afterEach(() => vi.clearAllMocks());

describe('grant confirmation (P2)', () => {
  test('offline: nothing is confirmed, so nothing can be pruned', async () => {
    http.GET.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(await confirmGrantOrgs([orgA])).toEqual([]);
  });

  test('an org whose groups cannot be fetched is not judged', async () => {
    http.GET.mockImplementation((path: string) =>
      path === '/api/v1/me' ? ok(me) : Promise.reject(new TypeError('Failed to fetch')),
    );
    const [org] = await confirmGrantOrgs([orgA]);
    expect(org?.groups).toBeUndefined();
  });

  test('the snapshot refetches when that org’s my-list (or /me) changes', async () => {
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useConfirmedGrantOrgs([orgA]), { wrapper });
    await waitFor(() => expect(result.current.orgs[0]?.groups?.map((g) => g.id)).toEqual(['g1']));
    // Another tab creates a group; this tab's list refreshes.
    groups = [...groups, { id: 'g2', name: 'New', kind: 'normal' }];
    queryClient.setQueryData(['my-list', orgA], { groups: [] });
    await waitFor(() =>
      expect(result.current.orgs[0]?.groups?.map((g) => g.id)).toEqual(['g1', 'g2']),
    );
    // Saving confirms afresh regardless of the snapshot.
    groups = [...groups, { id: 'g3', name: 'Newer', kind: 'normal' }];
    const fresh = await result.current.confirm();
    expect(fresh[0]?.groups?.map((g) => g.id)).toEqual(['g1', 'g2', 'g3']);
  });

  test('a background update never cancels the save’s confirmation (round 5)', async () => {
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useConfirmedGrantOrgs([orgA]), { wrapper });
    // The snapshot has loaded once (a refetch of a query with data is what gets cancelled).
    await waitFor(() => expect(result.current.orgs[0]?.groups).toBeDefined());
    // From here every request waits until released.
    const pending: (() => void)[] = [];
    http.GET.mockImplementation(
      (path: string) =>
        new Promise((resolve) => {
          pending.push(() =>
            resolve(
              path === '/api/v1/me'
                ? { data: me, response: new Response(null, { status: 200 }) }
                : {
                    data: { groups, tasks: [], expandedTaskIds: [], serverTime: 0 },
                    response: new Response(null, { status: 200 }),
                  },
            ),
          );
        }),
    );
    // A background confirmation is fetching…
    queryClient.setQueryData(['my-list', orgA], { groups: [] });
    await waitFor(() => expect(pending.length).toBeGreaterThan(0));
    // …when Save asks for a confirmation, then two cache updates invalidate the snapshot.
    const saving = result.current.confirm();
    queryClient.setQueryData(['my-list', orgA], { groups: [{}] });
    queryClient.setQueryData(['me'], { ...me });
    for (let k = 0; k < 10; k += 1) {
      while (pending.length > 0) pending.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await expect(saving).resolves.toEqual([
      expect.objectContaining({ id: orgA, groups: [expect.objectContaining({ id: 'g1' })] }),
    ]);
  });

  test('nothing is fetched while no grant is being edited', () => {
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useConfirmedGrantOrgs(null), { wrapper });
    expect(result.current.orgs).toEqual([]);
    expect(http.GET).not.toHaveBeenCalled();
  });
});
