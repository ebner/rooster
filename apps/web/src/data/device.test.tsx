import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { deviceErrorKind, useDenyDevice, useDeviceRequest } from './device';
import { sessionDataCleared } from './session-events';

const api = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock('./http', async (original) => ({ ...(await original<typeof import('./http')>()), api }));

const ok = (data: unknown) => ({ data, response: new Response(null, { status: 200 }) });

function wrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

afterEach(() => vi.resetAllMocks());

describe('the device request (decisionNonce, ADR 0051)', () => {
  test('a session change fetches the request again instead of keeping its nonce', async () => {
    api.GET.mockResolvedValueOnce(
      ok({ userCode: 'ABCD', decisionNonce: 'first' }),
    ).mockResolvedValueOnce(ok({ userCode: 'ABCD', decisionNonce: 'second' }));
    const { result } = renderHook(() => useDeviceRequest('ABCD'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data?.decisionNonce).toBe('first'));
    sessionDataCleared();
    await waitFor(() => expect(result.current.data?.decisionNonce).toBe('second'));
    expect(api.GET).toHaveBeenCalledTimes(2);
  });

  test('a stale nonce (404) reads as an unknown code', async () => {
    api.GET.mockResolvedValueOnce({
      error: { code: 'not_found' },
      response: new Response(null, { status: 404 }),
    });
    const { result } = renderHook(() => useDeviceRequest('ABCD'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(deviceErrorKind(result.current.error)).toBe('notFound');
  });

  test('deny sends the shown nonce back unchanged', async () => {
    api.POST.mockResolvedValueOnce(ok(undefined));
    const { result } = renderHook(() => useDenyDevice(), { wrapper: wrapper() });
    await act(() => result.current.mutateAsync({ userCode: 'ABCD', decisionNonce: 'n-1' }));
    expect(api.POST).toHaveBeenCalledWith('/api/v1/device/{userCode}/deny', {
      params: { path: { userCode: 'ABCD' } },
      body: { decisionNonce: 'n-1' },
    });
  });
});
