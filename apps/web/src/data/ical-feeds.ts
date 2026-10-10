import type { Schemas } from '@rooster/api-client';
import type { IcalFeed, IcalFeedCreate, IcalFeedCreated } from '@rooster/core/schemas';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from './http';
import type { MutationResult, QueryResult } from './types';

/**
 * Settings → Calendar feed (FR-CAL, 06 §2.8, ADR 0049 §4). Online-only: plain TanStack Query over
 * `@rooster/api-client` (hard rule 4). The feed URL holds a secret token the server keeps only
 * hashed, so it is in the create response and nowhere else.
 */
export const icalFeedKeys = {
  all: ['ical-feeds'] as const,
};

/** `GET /me/ical-feeds`. */
export function useIcalFeeds(): QueryResult<IcalFeed[]> {
  return useQuery({
    queryKey: icalFeedKeys.all,
    queryFn: async () => await unwrap(api.GET('/api/v1/me/ical-feeds')),
  });
}

/** `POST /me/ical-feeds {orgId?, replaces?}` → `{feed, url}`; `replaces` regenerates a feed. */
export function useCreateIcalFeed(): MutationResult<IcalFeedCreate, IcalFeedCreated> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: IcalFeedCreate) =>
      await unwrap(
        api.POST('/api/v1/me/ical-feeds', {
          // The core DTO with `exactOptionalPropertyTypes`: callers never set `undefined`.
          body: body as Schemas['IcalFeedCreate'],
        }),
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: icalFeedKeys.all }),
  });
}

/** `DELETE /me/ical-feeds/:id`: the URL answers 404 from now on. */
export function useRevokeIcalFeed(): MutationResult<string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await unwrap(api.DELETE('/api/v1/me/ical-feeds/{id}', { params: { path: { id } } }));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: icalFeedKeys.all }),
  });
}
