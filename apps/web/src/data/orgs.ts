import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api, unwrap } from './http';
import { toMember, toOrg } from './mappers';
import { useMe } from './me';
import { queryKeys } from './query-keys';
import type {
  CreateOrgInput,
  Me,
  MutationResult,
  Org,
  OrgMember,
  OrgPatch,
  OrgRole,
  QueryResult,
} from './types';

/** The alias that resolves to the caller's personal org (05 §2). */
export const personalAlias = 'personal';

export function findOrg(orgs: readonly Org[], slugOrAlias: string): Org | null {
  if (slugOrAlias === personalAlias) return orgs.find((o) => o.isPersonal) ?? null;
  return orgs.find((o) => o.slug === slugOrAlias || o.id === slugOrAlias) ?? null;
}

/** Resolves `/o/:orgSlug` from the orgs in `GET /me`; `null` when the user is not a member. */
export function useOrg(slugOrAlias: string): QueryResult<Org | null> {
  const me = useMe();
  return useMemo(
    () => ({
      data: me.data ? findOrg(me.data.orgs, slugOrAlias) : undefined,
      isPending: me.isPending,
      error: me.error,
    }),
    [me.data, me.isPending, me.error, slugOrAlias],
  );
}

/** `POST /orgs`. Resolves with the new org (appended to the sidebar). */
export function useCreateOrg(): MutationResult<CreateOrgInput, Org> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateOrgInput) =>
      toOrg(await unwrap(api.POST('/api/v1/orgs', { body: input }))),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}

/** `PATCH /orgs/:orgId` (owner; personal org: emoji and colour only). */
export function useUpdateOrg(): MutationResult<{ orgId: string; patch: OrgPatch }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ orgId, patch }: { orgId: string; patch: OrgPatch }) => {
      const org = toOrg(
        await unwrap(
          api.PATCH('/api/v1/orgs/{orgId}', { params: { path: { orgId } }, body: patch }),
        ),
      );
      queryClient.setQueryData<Me>(queryKeys.me, (me) =>
        me ? { ...me, orgs: me.orgs.map((o) => (o.id === org.id ? org : o)) } : me,
      );
    },
  });
}

/** `DELETE /orgs/:orgId` `{confirmName}`. */
export function useDeleteOrg(): MutationResult<{ orgId: string; confirmName: string }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ orgId, confirmName }: { orgId: string; confirmName: string }) => {
      await unwrap(
        api.DELETE('/api/v1/orgs/{orgId}', { params: { path: { orgId } }, body: { confirmName } }),
      );
    },
    onSuccess: async (_data, { orgId }) => {
      queryClient.setQueryData<Me>(queryKeys.me, (me) =>
        me ? { ...me, orgs: me.orgs.filter((o) => o.id !== orgId) } : me,
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}

/** `GET /orgs/:orgId/members`. */
export function useOrgMembers(orgId: string | undefined): QueryResult<OrgMember[]> {
  return useQuery({
    queryKey: queryKeys.orgMembers(orgId ?? ''),
    queryFn: async () =>
      (
        await unwrap(
          api.GET('/api/v1/orgs/{orgId}/members', { params: { path: { orgId: orgId ?? '' } } }),
        )
      ).map(toMember),
    enabled: Boolean(orgId),
  });
}

/** `PATCH /orgs/:orgId/members/:userId` `{role}`; the last owner cannot be demoted. */
export function useUpdateMemberRole(): MutationResult<{
  orgId: string;
  userId: string;
  role: OrgRole;
}> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      orgId,
      userId,
      role,
    }: {
      orgId: string;
      userId: string;
      role: OrgRole;
    }) => {
      await unwrap(
        api.PATCH('/api/v1/orgs/{orgId}/members/{userId}', {
          params: { path: { orgId, userId } },
          body: { role },
        }),
      );
    },
    onSettled: async (_data, _error, { orgId }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.orgMembers(orgId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.me }),
      ]);
    },
  });
}

/** `DELETE /orgs/:orgId/members/:userId` (owner removes someone, or anyone leaves). */
export function useRemoveMember(): MutationResult<{ orgId: string; userId: string }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ orgId, userId }: { orgId: string; userId: string }) => {
      await unwrap(
        api.DELETE('/api/v1/orgs/{orgId}/members/{userId}', {
          params: { path: { orgId, userId } },
        }),
      );
    },
    onSuccess: async (_data, { orgId }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.orgMembers(orgId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.me }),
      ]);
    },
  });
}
