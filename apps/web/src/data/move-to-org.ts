import { BULK_MAX } from '@rooster/core/limits';
import { orderedGroups } from '@rooster/core/reducers';
import type { Group, TaskMoveToOrgPreview } from '@rooster/core/schemas';
import { useQuery } from '@tanstack/react-query';
import { api, unwrap } from './http';
import { myListKey, useListPipeline } from './list';
import { queryKeys } from './query-keys';
import type { QueryResult } from './types';

/** ADR 0072 (moving tasks to another org): what the picker reads. The move itself is a list op. */

/** The preview's `ids` parameter: each id once, in a stable order (so the cache key is too). */
export function previewIds(ids: readonly string[]): string {
  return [...new Set(ids)].sort().join(',');
}

/**
 * GET /tasks/move-to-org/preview (06, ADR 0072 §19): no side effects. The endpoint takes at most
 * `BULK_MAX` ids, like the move, which the controller sends in chunks; so does this, adding the
 * chunks up. A task and a selected descendant in different chunks are then counted twice, which
 * only overstates the numbers the confirmation shows; `exposes` and `newTags` stay exact.
 */
export async function fetchMoveToOrgPreview(
  ids: readonly string[],
  orgId: string,
  signal?: AbortSignal,
): Promise<TaskMoveToOrgPreview> {
  const unique = previewIds(ids).split(',');
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += BULK_MAX) chunks.push(unique.slice(i, i + BULK_MAX));
  const parts = await Promise.all(
    chunks.map((chunk) =>
      unwrap(
        api.GET('/api/v1/tasks/move-to-org/preview', {
          params: { query: { ids: chunk.join(','), orgId } },
          ...(signal ? { signal } : {}),
        }),
      ),
    ),
  );
  return parts.reduce((sum, part) => ({
    tasks: sum.tasks + part.tasks,
    subtasks: sum.subtasks + part.subtasks,
    comments: sum.comments + part.comments,
    attachments: sum.attachments + part.attachments,
    exposes: sum.exposes || part.exposes,
    newTags: [
      ...sum.newTags,
      ...part.newTags.filter(
        (name) => !sum.newTags.some((t) => t.toLocaleLowerCase() === name.toLocaleLowerCase()),
      ),
    ],
    reassigned: sum.reassigned + part.reassigned,
  }));
}

/**
 * The picker's preview (`GET /tasks/move-to-org/preview`, ADR 0072 §19). Online only (§21):
 * offline it errors at once (never paused or retried), and the picker says it needs a
 * connection. Idle while `orgId` is null or `ids` is empty. Pass the ids the move would take
 * (`ListController.movableToOrg`): the server does not know tasks whose create is still queued.
 */
export function useMoveToOrgPreview(
  ids: readonly string[],
  orgId: string | null,
): QueryResult<TaskMoveToOrgPreview> {
  const key = previewIds(ids);
  const query = useQuery({
    queryKey: queryKeys.moveToOrgPreview(orgId ?? '', key),
    queryFn: ({ signal }) => fetchMoveToOrgPreview(ids, orgId as string, signal),
    enabled: orgId !== null && key !== '',
    // Comments and files change while the picker is open only rarely; reopening it asks again.
    staleTime: 5_000,
    gcTime: 60_000,
    retry: false,
    networkMode: 'always',
  });
  return { data: query.data, isPending: query.isPending, error: query.error };
}

/**
 * The actor's groups in the target org for the picker's second step, in their order with the
 * Inbox first. Idle while `orgId` is null. Reads that org's `['my-list', orgId]` (cached when
 * the user has opened it; fetched through the pipeline otherwise, which also has it ready for
 * the refetch after the move).
 */
export function useMoveTargetGroups(orgId: string | null): QueryResult<readonly Group[]> {
  const pipeline = useListPipeline();
  const query = useQuery({
    queryKey: myListKey(orgId ?? ''),
    queryFn: () => pipeline.fetch(orgId as string),
    enabled: orgId !== null,
    staleTime: 30_000,
    select: orderedGroups,
  });
  return { data: query.data, isPending: query.isPending, error: query.error };
}
