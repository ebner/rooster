import { createRoosterClient } from '@rooster/api-client';
import { ApiError } from './errors';

/**
 * The typed REST client. Same-origin (Vite proxies /api in development), so the
 * session cookie travels automatically and the CSRF Origin check passes (06 §1).
 */
export const api = createRoosterClient({
  baseUrl: globalThis.location?.origin ?? '',
  clientName: 'web',
});

interface FetchResult<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

/** Maps a problem+json body (04 §4.10) or a bare status to an `ApiError`. */
export function toApiError(body: unknown, status: number): ApiError {
  if (body && typeof body === 'object' && 'code' in body && typeof body.code === 'string') {
    const detail = 'detail' in body && typeof body.detail === 'string' ? body.detail : undefined;
    return new ApiError(body.code, status, detail);
  }
  return new ApiError(status === 401 ? 'unauthenticated' : `http_${status}`, status);
}

/** Resolves with the response body, or throws an `ApiError` for any non-2xx status. */
export async function unwrap<T>(request: Promise<FetchResult<T>>): Promise<T> {
  const { data, error, response } = await request;
  if (!response.ok) throw toApiError(error, response.status);
  return data as T;
}
