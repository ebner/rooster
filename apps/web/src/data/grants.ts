import type { Schemas } from '@rooster/api-client';
import { orderedGroups } from '@rooster/core/reducers';
import type { Grant, GrantPatch, TokenCreate, TokenCreated } from '@rooster/core/schemas';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { GrantOrgOption } from '../features/access/grant-model';
import { api, unwrap } from './http';
import { myListKey, useListPipeline } from './list';
import { toMe } from './mappers';
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

/**
 * Server-confirmed orgs and groups for pruning a grant's stale ids (P2): a fresh `/me` and
 * each named org's groups from the server, never the optimistic `my-list` cache (where a live
 * group this tab has not fetched yet looks deleted). Never throws: without a fresh `/me` the
 * list is empty, and an org whose groups could not be fetched has `groups: undefined`, so
 * nothing is pruned for it and the server has the last word.
 */
export async function confirmGrantOrgs(orgIds: readonly string[]): Promise<GrantOrgOption[]> {
  let orgs: Awaited<ReturnType<typeof toMe>>['orgs'];
  try {
    orgs = toMe(await unwrap(api.GET('/api/v1/me'))).orgs;
  } catch {
    return [];
  }
  return Promise.all(
    orgs.map(async (org) => ({
      id: org.id,
      name: org.name,
      isPersonal: org.isPersonal,
      groups: orgIds.includes(org.id)
        ? await unwrap(
            api.GET('/api/v1/orgs/{orgId}/my-list', { params: { path: { orgId: org.id } } }),
          ).then(
            (list) =>
              list.groups.map((group) => ({
                id: group.id,
                name: group.name,
                isInbox: group.kind === 'inbox',
              })),
            () => undefined,
          )
        : undefined,
    })),
  );
}

const confirmKey = (orgIds: readonly string[]) =>
  ['grant-confirm', [...orgIds].sort().join(',')] as const;

export interface ConfirmedGrantOrgs {
  /** The latest confirmation (for the "no longer exists" note); empty until it arrives. */
  orgs: GrantOrgOption[];
  /** Confirms afresh, now: call right before pruning on save. */
  confirm: () => Promise<GrantOrgOption[]>;
}

/**
 * `confirmGrantOrgs` for the grant being edited (`orgIds`, or null when none is). The snapshot
 * is refetched whenever `/me` or one of those orgs' `my-list` changes (another tab created a
 * group, SSE), so the note stays accurate; saving still re-confirms first (`confirm`).
 */
export function useConfirmedGrantOrgs(orgIds: readonly string[] | null): ConfirmedGrantOrgs {
  const queryClient = useQueryClient();
  const ids = orgIds ?? [];
  const key = confirmKey(ids);
  const query = useQuery({
    queryKey: key,
    queryFn: () => confirmGrantOrgs(ids),
    enabled: orgIds !== null,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const watched = key[1];
  useEffect(() => {
    if (orgIds === null) return;
    const names = watched.split(',');
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'success') return;
      const [root, orgId] = event.query.queryKey;
      const related = root === 'me' || (root === 'my-list' && names.includes(String(orgId)));
      if (related) void queryClient.invalidateQueries({ queryKey: ['grant-confirm', watched] });
    });
  }, [queryClient, watched, orgIds === null]);
  return {
    orgs: query.data ?? [],
    confirm: () =>
      queryClient.fetchQuery({ queryKey: key, queryFn: () => confirmGrantOrgs(ids), staleTime: 0 }),
  };
}
