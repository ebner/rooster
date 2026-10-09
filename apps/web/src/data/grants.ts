import type { Schemas } from '@rooster/api-client';
import { orderedGroups } from '@rooster/core/reducers';
import type { Grant, GrantPatch, TokenCreate, TokenCreated } from '@rooster/core/schemas';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GrantOrgOption } from '../features/access/grant-model';
import { api, unwrap } from './http';
import { myListKey, useListPipeline } from './list';
import { useMe } from './me';
import type { MutationResult, QueryResult } from './types';

/**
 * Settings → Connected apps (11 §3.2, 06 §2.1). Online-only, browser session only: plain
 * TanStack Query over `@rooster/api-client` (hard rule 4).
 */
export const grantKeys = {
  all: ['grants'] as const,
};

/** `GET /me/grants`: every PAT, CLI device and OAuth app grant. */
export function useGrants(): QueryResult<Grant[]> {
  return useQuery({
    queryKey: grantKeys.all,
    queryFn: async () => await unwrap(api.GET('/api/v1/me/grants')),
  });
}

/** `PATCH /me/grants/:id`: takes effect on the credential's next request (AC-8.5). */
export function useUpdateGrant(): MutationResult<{ id: string; patch: GrantPatch }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: GrantPatch }) => {
      await unwrap(
        api.PATCH('/api/v1/me/grants/{id}', {
          params: { path: { id } },
          // The core DTO with `exactOptionalPropertyTypes`: the model never sets `undefined`.
          body: patch as Schemas['GrantPatch'],
        }),
      );
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: grantKeys.all }),
  });
}

/** `DELETE /me/grants/:id`: the credential gets `401` from its next request on. */
export function useRevokeGrant(): MutationResult<{ id: string }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      await unwrap(api.DELETE('/api/v1/me/grants/{id}', { params: { path: { id } } }));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: grantKeys.all }),
  });
}

/** `POST /me/tokens`: a PAT; the secret is in this response only. */
export function useCreateToken(): MutationResult<TokenCreate, TokenCreated> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: TokenCreate) =>
      await unwrap(api.POST('/api/v1/me/tokens', { body: body as Schemas['TokenCreate'] })),
    onSettled: () => queryClient.invalidateQueries({ queryKey: grantKeys.all }),
  });
}

/**
 * The user's orgs (sidebar order) with their groups for the constraint editor. Groups come
 * from the cached `['my-list', orgId]` (Inbox first), so they are usually there already.
 */
export function useGrantOrgs(): GrantOrgOption[] {
  const me = useMe();
  const pipeline = useListPipeline();
  const orgs = me.data?.orgs ?? [];
  const groups = useQueries({
    queries: orgs.map((org) => ({
      queryKey: myListKey(org.id),
      queryFn: () => pipeline.fetch(org.id),
      staleTime: 30_000,
      select: (state: Parameters<typeof orderedGroups>[0]) =>
        orderedGroups(state).map((group) => ({
          id: group.id,
          name: group.name,
          isInbox: group.kind === 'inbox',
        })),
    })),
  });
  return orgs.map((org, index) => ({
    id: org.id,
    name: org.name,
    isPersonal: org.isPersonal,
    groups: groups[index]?.data,
  }));
}
