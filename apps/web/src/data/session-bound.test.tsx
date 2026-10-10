import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useCreateToken } from './grants';
import { useCreateIcalFeed } from './ical-feeds';
import { useCreateInvite } from './invites';
import { inSession } from './session-bound';
import { sessionDataCleared } from './session-events';

const api = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock('./http', async (original) => ({ ...(await original<typeof import('./http')>()), api }));

afterEach(() => vi.resetAllMocks());

describe('secrets shown once are bound to their session (ADR 0051)', () => {
  test('inSession drops an answer that arrives after the session ended', async () => {
    await expect(inSession(async () => 'kept')).resolves.toBe('kept');
    let answer: (value: string) => void = () => {};
    const late = inSession(() => new Promise<string>((resolve) => (answer = resolve)));
    sessionDataCleared();
    answer('rst_pat_secret');
    await expect(late).rejects.toMatchObject({ code: 'aborted' });
  });

  type Sends = () => { mutateAsync: (input: never) => Promise<unknown> };
  test.each<[string, Sends, unknown]>([
    ['a new token', () => useCreateToken(), { name: 't', scopes: [], constraints: {} }],
    ['a calendar feed URL', () => useCreateIcalFeed(), {}],
    [
      'an invite link',
      () => useCreateInvite(),
      { kind: 'link', orgId: 'o', role: 'member', multiUse: false, expiresInDays: 7 },
    ],
  ])('%s answered after the session ended is never kept', async (_name, hook, input) => {
    let answer: () => void = () => {};
    api.POST.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = () =>
          resolve({
            data: { id: 'x', kind: 'link', url: 'https://secret', token: 'rst_pat_secret' },
            response: new Response(null, { status: 201 }),
          });
      }),
    );
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(hook, { wrapper });
    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = (result.current.mutateAsync as (v: unknown) => Promise<unknown>)(input);
    });
    await vi.waitFor(() => expect(api.POST).toHaveBeenCalled());
    sessionDataCleared();
    answer();
    await act(async () => {
      await expect(done).rejects.toMatchObject({ code: 'aborted' });
    });
    expect(
      queryClient
        .getMutationCache()
        .getAll()
        .some((m) => m.state.data !== undefined),
    ).toBe(false);
  });
});
