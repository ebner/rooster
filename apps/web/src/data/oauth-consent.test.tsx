import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { consentErrorKind, useOAuthConsentRequest } from './oauth-consent';
import { sessionDataCleared } from './session-events';

const api = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock('./http', async (original) => ({ ...(await original<typeof import('./http')>()), api }));

const shown = (decisionNonce: string) => ({
  data: { oauthQuery: 'q', decisionNonce },
  response: new Response(null, { status: 200 }),
});

function render() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(() => useOAuthConsentRequest('q'), { wrapper });
}

afterEach(() => vi.resetAllMocks());

describe('the consent request (decisionNonce, ADR 0051)', () => {
  test('a session change fetches the request again instead of keeping its nonce', async () => {
    api.GET.mockResolvedValueOnce(shown('first')).mockResolvedValueOnce(shown('second'));
    const { result } = render();
    await waitFor(() => expect(result.current.data?.decisionNonce).toBe('first'));
    sessionDataCleared();
    await waitFor(() => expect(result.current.data?.decisionNonce).toBe('second'));
    expect(api.GET).toHaveBeenCalledTimes(2);
  });

  test('a malformed or stale request (404) reads as unknown or expired', async () => {
    api.GET.mockResolvedValueOnce({
      error: { code: 'not_found' },
      response: new Response(null, { status: 404 }),
    });
    const { result } = render();
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(consentErrorKind(result.current.error)).toBe('invalid');
  });
});
