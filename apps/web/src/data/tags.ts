import type { ListOp } from '@rooster/core/reducers';
import type { Tag, TagPatch } from '@rooster/core/schemas';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useSyncExternalStore } from 'react';
import { api, unwrap } from './http';
import { useListPipeline } from './list';
import { myListKey, tagsKey } from './pipeline/pipeline';
import type { MutationResult, QueryResult } from './types';

export { tagsKey } from './pipeline/pipeline';

/** A stable key of the queued `tag.create` ops ('' when there are none). */
function pendingTagKey(ops: readonly ListOp[]): string {
  let key = '';
  for (const op of ops) if (op.kind === 'tag.create') key += `${op.entityId},`;
  return key;
}

/** Tags created by queued ops, shown before the server confirms them. */
export function withPendingTags(tags: readonly Tag[], ops: readonly ListOp[], orgId: string) {
  const pending = ops.flatMap((op) =>
    op.kind === 'tag.create' && !tags.some((t) => t.id === op.entityId)
      ? [
          {
            id: op.entityId,
            orgId,
            name: op.payload.name,
            color: op.payload.color ?? 'gray',
            createdAt: op.editTime,
          } satisfies Tag,
        ]
      : [],
  );
  return pending.length === 0 ? tags : [...tags, ...pending];
}

/**
 * `['tags', orgId]` (04 §5.1) with the tags of pending `tag.create` ops added, so a tag created
 * from a title or the picker shows at once (its colour settles when the server answers).
 */
export function useTags(orgId: string | undefined): QueryResult<readonly Tag[]> {
  const pipeline = useListPipeline();
  const query = useQuery({
    queryKey: tagsKey(orgId ?? ''),
    queryFn: () => pipeline.transport.fetchTags(orgId as string),
    enabled: Boolean(orgId),
    staleTime: 60_000,
  });
  // Only queued tag creations matter here: other ops must not re-render tag consumers.
  const pendingKey = useSyncExternalStore(pipeline.subscribe, () =>
    orgId ? pendingTagKey(pipeline.pendingOps(orgId)) : '',
  );
  const data = useMemo(
    () =>
      query.data && orgId && pendingKey !== ''
        ? withPendingTags(query.data, pipeline.pendingOps(orgId), orgId)
        : query.data,
    [query.data, orgId, pipeline, pendingKey],
  );
  return { data, isPending: query.isPending, error: query.error };
}

/**
 * Settings → Tags (FR-TAG-3) is online-only (hard rule 4): plain mutations, then the tags and
 * the list (merge and delete change task tags) are refetched.
 */
function useTagMutation<V>(
  orgId: string,
  run: (vars: V) => Promise<unknown>,
): MutationResult<V, unknown> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: tagsKey(orgId) }),
        queryClient.invalidateQueries({ queryKey: myListKey(orgId) }),
        queryClient.invalidateQueries({ queryKey: ['task'] }),
      ]);
    },
  });
}

export function useUpdateTag(orgId: string) {
  return useTagMutation(orgId, ({ id, patch }: { id: string; patch: TagPatch }) =>
    unwrap(
      api.PATCH('/api/v1/tags/{id}', {
        params: { path: { id } },
        body: {
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.color === undefined ? {} : { color: patch.color }),
        },
      }),
    ),
  );
}

export function useMergeTag(orgId: string) {
  return useTagMutation(orgId, ({ id, intoId }: { id: string; intoId: string }) =>
    unwrap(api.POST('/api/v1/tags/{id}/merge', { params: { path: { id } }, body: { intoId } })),
  );
}

export function useDeleteTag(orgId: string) {
  return useTagMutation(orgId, (id: string) =>
    unwrap(api.DELETE('/api/v1/tags/{id}', { params: { path: { id } } })),
  );
}
