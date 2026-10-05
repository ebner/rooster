import { applyOpToDetail, type ListOp } from '@rooster/core/reducers';
import type { TaskDetail } from '@rooster/core/schemas';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useSyncExternalStore } from 'react';
import { useListPipeline } from './list';
import { taskDetailKey } from './pipeline/pipeline';
import type { QueryResult } from './types';

export { taskDetailKey } from './pipeline/pipeline';

/** The server detail with the queued ops replayed on top (what the pane shows). */
export function overlayDetail(
  detail: TaskDetail,
  ops: readonly ListOp[],
  userId: string,
): TaskDetail {
  let view = detail;
  for (const op of ops) view = applyOpToDetail(view, op, { userId, now: op.editTime });
  return view;
}

/**
 * `['task', id]` (04 §5.1): GET /tasks/:id, with pending ops applied. The pipeline moves
 * confirmed ops into the cached detail, so edits never flicker back.
 */
export function useTaskDetail(
  taskId: string | null,
  orgId: string,
  userId: string,
  /** The list already shows the task's fields: only queued description edits matter here. */
  descriptionOnly = false,
): QueryResult<TaskDetail> {
  const pipeline = useListPipeline();
  const query = useQuery({
    queryKey: taskDetailKey(taskId ?? ''),
    queryFn: () => pipeline.transport.fetchTask(taskId as string),
    enabled: Boolean(taskId),
    staleTime: 10_000,
    retry: false,
  });
  const relevant = (op: ListOp) =>
    descriptionOnly
      ? op.kind === 'task.patch' && op.entityId === taskId && op.payload.description !== undefined
      : query.data !== undefined &&
        applyOpToDetail(query.data, op, { userId, now: op.editTime }) !== query.data;
  // Re-render only when the queued ops that change this detail change, not on every op.
  const key = useSyncExternalStore(pipeline.subscribe, () =>
    pipeline
      .pendingOps(orgId)
      .filter(relevant)
      .map((op) => op.opId)
      .join(),
  );
  const data = useMemo(
    () =>
      query.data
        ? overlayDetail(query.data, key === '' ? [] : pipeline.pendingOps(orgId), userId)
        : undefined,
    [query.data, orgId, userId, pipeline, key],
  );
  return { data, isPending: query.isPending, error: query.error };
}
