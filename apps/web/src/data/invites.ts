import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { startSignIn } from './auth';
import { ApiError } from './errors';
import { api, unwrap } from './http';
import { notFoundPreview, toInvite, toInvitePreview, toOrg } from './mappers';
import { queryKeys } from './query-keys';
import type {
  CreatedInvite,
  CreateInviteInput,
  InvitePreview,
  MutationResult,
  Org,
  OrgInvite,
  QueryResult,
} from './types';

/** `GET /orgs/:orgId/invites`. Link URLs are null here: only the create response has them. */
export function useOrgInvites(orgId: string | undefined): QueryResult<OrgInvite[]> {
  return useQuery({
    queryKey: queryKeys.orgInvites(orgId ?? ''),
    queryFn: async () =>
      (
        await unwrap(
          api.GET('/api/v1/orgs/{orgId}/invites', { params: { path: { orgId: orgId ?? '' } } }),
        )
      ).map(toInvite),
    enabled: Boolean(orgId),
  });
}

/** `POST /orgs/:orgId/invites` (email or link invite); resolves with the URL to copy. */
export function useCreateInvite(): MutationResult<CreateInviteInput, CreatedInvite> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateInviteInput) => {
      const body =
        input.kind === 'email'
          ? { email: input.email, role: input.role, expiresInDays: input.expiresInDays }
          : { role: input.role, multiUse: input.multiUse, expiresInDays: input.expiresInDays };
      const created = await unwrap(
        api.POST('/api/v1/orgs/{orgId}/invites', {
          params: { path: { orgId: input.orgId } },
          body,
        }),
      );
      return { id: created.id, kind: created.kind, url: created.url };
    },
    onSuccess: async (_data, input) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.orgInvites(input.orgId) });
    },
  });
}

/** `DELETE /orgs/:orgId/invites/:id`. */
export function useRevokeInvite(): MutationResult<{ orgId: string; inviteId: string }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ orgId, inviteId }: { orgId: string; inviteId: string }) => {
      await unwrap(
        api.DELETE('/api/v1/orgs/{orgId}/invites/{id}', {
          params: { path: { orgId, id: inviteId } },
        }),
      );
    },
    onSettled: async (_data, _error, { orgId }) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.orgInvites(orgId) });
    },
  });
}

async function fetchPreview(token: string): Promise<InvitePreview> {
  try {
    const preview = await unwrap(
      api.GET('/api/v1/invites/{token}', { params: { path: { token } } }),
    );
    return toInvitePreview(token, preview);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return notFoundPreview;
    throw error;
  }
}

/** `GET /invites/:token` (no auth). Unknown tokens come back as `notFound`. */
export function useInvitePreview(token: string): QueryResult<InvitePreview> {
  return useQuery({
    queryKey: queryKeys.invitePreview(token),
    queryFn: () => fetchPreview(token),
    staleTime: 0,
  });
}

/** `POST /invites/:token/accept` for a signed-in user; resolves with the joined org. */
export function useAcceptInvite(): MutationResult<{ token: string }, Org> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ token }: { token: string }) =>
      toOrg(
        await unwrap(api.POST('/api/v1/invites/{token}/accept', { params: { path: { token } } })),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}

/**
 * Accept by signing in: `claim` stores the token in the signed `rooster.invite`
 * cookie (04 §4.4), then the OAuth flow starts; the server creates the membership on
 * callback, and the user comes back to this invite page, which forwards to the org.
 */
export function useSignInWithInvite(): MutationResult<{ token: string; providerId: string }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ token, providerId }: { token: string; providerId: string }) => {
      try {
        await unwrap(api.POST('/api/v1/invites/{token}/claim', { params: { path: { token } } }));
      } catch (error) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.invitePreview(token) });
        throw error;
      }
      await startSignIn({ providerId, callbackUrl: `/invite/${encodeURIComponent(token)}` });
    },
  });
}
