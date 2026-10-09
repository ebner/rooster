import { isLocale, type Locale } from '@rooster/i18n/core';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { DisplayPrefs } from '../lib/format';
import { setLocale } from '../lib/i18n';
import { api, unwrap } from './http';
import { toMe } from './mappers';
import { queryKeys } from './query-keys';
import type { Me, MutationResult, OrgReorderIntent, ProfilePatch, QueryResult } from './types';

/** `GET /me`; also the auth probe of the route guards (401 → `/login`). */
export const meQueryOptions = queryOptions({
  queryKey: queryKeys.me,
  queryFn: async () => toMe(await unwrap(api.GET('/api/v1/me'))),
  staleTime: 30_000,
  retry: false,
});

export function useMe(): QueryResult<Me> {
  return useQuery(meQueryOptions);
}

/** What the server can deliver (`GET /meta` `features`): AC-7.3 hides email without SMTP. */
export interface ServerFeatures {
  email: boolean;
  push: boolean;
}

/**
 * `GET /meta` → `features`. Its own key under `meta`: the login page caches the providers
 * under `['meta']` itself. The configuration only changes with a restart.
 */
export function useServerFeatures(): QueryResult<ServerFeatures> {
  return useQuery({
    queryKey: [...queryKeys.meta, 'features'],
    queryFn: async () => {
      const { features } = await unwrap(api.GET('/api/v1/meta'));
      return { email: features.email, push: features.push };
    },
    staleTime: 5 * 60_000,
  });
}

/** `PATCH /me`. */
export function useUpdateProfile(): MutationResult<ProfilePatch> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (patch: ProfilePatch) => {
      const me = await unwrap(api.PATCH('/api/v1/me', { body: patch }));
      queryClient.setQueryData(queryKeys.me, toMe(me));
    },
  });
}

/** Switches the UI language immediately and stores it on the profile. */
export function useChangeLocale(): MutationResult<Locale> {
  const queryClient = useQueryClient();
  const update = useUpdateProfile();
  return {
    isPending: update.isPending,
    mutateAsync: async (locale: Locale) => {
      // Update the cached profile first: the shell follows the profile's language.
      queryClient.setQueryData<Me>(queryKeys.me, (me) =>
        me ? { ...me, user: { ...me.user, locale } } : me,
      );
      await setLocale(locale);
      await update.mutateAsync({ locale });
    },
  };
}

/** Applies `fn` to the cached `/me`; returns the previous value for rollback. */
function useOptimisticMe() {
  const queryClient = useQueryClient();
  return async (fn: (me: Me) => Me) => {
    await queryClient.cancelQueries({ queryKey: queryKeys.me });
    const previous = queryClient.getQueryData<Me>(queryKeys.me);
    if (previous) queryClient.setQueryData(queryKeys.me, fn(previous));
    return previous;
  };
}

/** `PUT /me/org-order`, optimistic, rolled back on failure. */
export function useReorderOrg(): MutationResult<OrgReorderIntent> {
  const queryClient = useQueryClient();
  const optimistic = useOptimisticMe();
  return useMutation({
    mutationFn: async (intent: OrgReorderIntent) => {
      await unwrap(api.PUT('/api/v1/me/org-order', { body: intent }));
    },
    onMutate: ({ orgId, afterId }) =>
      optimistic((me) => {
        const moved = me.orgs.find((o) => o.id === orgId);
        if (!moved) return me;
        const rest = me.orgs.filter((o) => o.id !== orgId);
        rest.splice(afterId === null ? 0 : rest.findIndex((o) => o.id === afterId) + 1, 0, moved);
        return { ...me, orgs: rest };
      }),
    onError: (_error, _intent, previous) => {
      if (previous) queryClient.setQueryData(queryKeys.me, previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.me }),
  });
}

/** `PATCH /me/orgs/:orgId` `{collapsed}`, optimistic. */
export function useSetOrgCollapsed(): MutationResult<{ orgId: string; collapsed: boolean }> {
  const queryClient = useQueryClient();
  const optimistic = useOptimisticMe();
  return useMutation({
    mutationFn: async ({ orgId, collapsed }: { orgId: string; collapsed: boolean }) => {
      await unwrap(
        api.PATCH('/api/v1/me/orgs/{orgId}', { params: { path: { orgId } }, body: { collapsed } }),
      );
    },
    onMutate: ({ orgId, collapsed }) =>
      optimistic((me) => ({
        ...me,
        orgs: me.orgs.map((o) => (o.id === orgId ? { ...o, collapsed } : o)),
      })),
    onError: (_error, _vars, previous) => {
      if (previous) queryClient.setQueryData(queryKeys.me, previous);
    },
  });
}

/** The viewer's display settings for dates and times; the UI language wins over the stored one. */
export function useDisplayPrefs(): DisplayPrefs {
  const { i18n } = useTranslation();
  const user = useMe().data?.user;
  const locale: Locale = isLocale(i18n.language) ? i18n.language : 'en';
  return useMemo(
    () => ({
      locale,
      timezone: user?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      dateFormat: user?.dateFormat ?? 'MMM d',
      timeFormat: user?.timeFormat ?? '24h',
    }),
    [locale, user?.timezone, user?.dateFormat, user?.timeFormat],
  );
}
