import { applyOpToDetail, type ListOp, type ReducerContext } from '@rooster/core/reducers';
import type { TaskDetail } from '@rooster/core/schemas';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useSyncExternalStore } from 'react';
import { useListPipeline } from './list';
import { useMe } from './me';
import { taskDetailKey } from './pipeline/pipeline';
import type { QueryResult } from './types';

export { taskDetailKey } from './pipeline/pipeline';

/** The server detail with the queued ops replayed on top (what the pane shows). */
export function overlayDetail(
  detail: TaskDetail,
  ops: readonly ListOp[],
  ctx: ReducerContext,
): TaskDetail {
  let view = detail;
  for (const op of ops) view = applyOpToDetail(view, op, { ...ctx, now: op.editTime });
  return view;
}

/** Ops that change what a detail shows, or (`descriptionOnly`) just its description. */
function touchesDetail(op: ListOp, taskId: string | null, descriptionOnly: boolean): boolean {
  // P10: the viewer's reminders live only in the detail (ADR 0049 §2.7).
  if ((op.kind === 'reminder.create' || op.kind === 'reminder.delete') && op.taskId === taskId) {
    return true;
  }
  return (
    descriptionOnly &&
    op.kind === 'task.patch' &&
    op.entityId === taskId &&
    op.payload.description !== undefined
  );
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
  const me = useMe().data;
  // P10: optimistic reminder times resolve in the viewer's zone and all-day reminder time.
  const timezone = me?.user.timezone;
  const allDayReminderTime = me?.prefs?.allDayReminderTime;
  const ctx = useMemo<ReducerContext>(
    () => ({
      userId,
      ...(timezone ? { timezone } : {}),
      ...(allDayReminderTime ? { allDayReminderTime } : {}),
    }),
    [userId, timezone, allDayReminderTime],
  );
  const query = useQuery({
    queryKey: taskDetailKey(taskId ?? ''),
    queryFn: () => pipeline.transport.fetchTask(taskId as string),
    enabled: Boolean(taskId),
    staleTime: 10_000,
    retry: false,
  });
  const relevant = (op: ListOp) =>
    touchesDetail(op, taskId, descriptionOnly) ||
    (!descriptionOnly &&
      query.data !== undefined &&
      applyOpToDetail(query.data, op, { ...ctx, now: op.editTime }) !== query.data);
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
        ? overlayDetail(query.data, key === '' ? [] : pipeline.pendingOps(orgId), ctx)
        : undefined,
    [query.data, orgId, ctx, pipeline, key],
  );
  return { data, isPending: query.isPending, error: query.error };
}
