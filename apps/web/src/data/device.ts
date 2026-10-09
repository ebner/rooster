import type { Schemas } from '@rooster/api-client';
import type { DeviceApprove, DeviceRequest } from '@rooster/core/schemas';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError } from './errors';
import { api, unwrap } from './http';
import type { MutationResult, QueryResult } from './types';

/**
 * The `/device` approval page (07 §2, 11 §3.1, ADR 0036): rooster's wrappers around
 * better-auth's device authorization, so the approval carries scopes and constraints.
 */
export const deviceKeys = {
  request: (userCode: string) => ['device', userCode] as const,
};

/** `GET /device/:userCode`: who is asking for what. Not retried: a wrong code stays wrong. */
export function useDeviceRequest(userCode: string | undefined): QueryResult<DeviceRequest> {
  return useQuery({
    queryKey: deviceKeys.request(userCode ?? ''),
    queryFn: async () =>
      await unwrap(
        api.GET('/api/v1/device/{userCode}', {
          params: { path: { userCode: userCode as string } },
        }),
      ),
    enabled: Boolean(userCode),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
}

/** `POST /device/:userCode/approve`. */
export function useApproveDevice(): MutationResult<{ userCode: string; body: DeviceApprove }> {
  return useMutation({
    mutationFn: async ({ userCode, body }: { userCode: string; body: DeviceApprove }) => {
      await unwrap(
        api.POST('/api/v1/device/{userCode}/approve', {
          params: { path: { userCode } },
          body: body as Schemas['DeviceApprove'],
        }),
      );
    },
  });
}

/** `POST /device/:userCode/deny`. */
export function useDenyDevice(): MutationResult<{ userCode: string }> {
  return useMutation({
    mutationFn: async ({ userCode }: { userCode: string }) => {
      await unwrap(api.POST('/api/v1/device/{userCode}/deny', { params: { path: { userCode } } }));
    },
  });
}

export type DeviceErrorKind = 'notFound' | 'expired' | 'used' | 'failed';

/** Maps the server's problem codes to what the page explains. */
export function deviceErrorKind(error: unknown): DeviceErrorKind {
  if (!(error instanceof ApiError)) return 'failed';
  const code = error.code;
  if (code.includes('expired') || error.status === 410) return 'expired';
  if (/used|already|approved|denied|processed/.test(code) || error.status === 409) return 'used';
  if (error.status === 404 || error.status === 400 || code.includes('not_found')) return 'notFound';
  return 'failed';
}
