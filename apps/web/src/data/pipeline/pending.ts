import { useSyncExternalStore } from 'react';
import { useListPipeline } from '../list';

/**
 * Whether a task or comment still has an op in the outbox, unsent or unanswered (04 §6.2): the
 * comment composer shows "Sending…" for such a comment. Re-renders only when the answer flips.
 * IDs match `opEntityIds` (a comment create counts for the comment and for its task).
 */
export function usePendingEntity(entityId: string | null | undefined): boolean {
  const pipeline = useListPipeline();
  return useSyncExternalStore(pipeline.subscribe, () =>
    entityId ? pipeline.hasPending(entityId) : false,
  );
}
