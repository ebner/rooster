import type { Group, TaskMoveToOrgPreview } from '@rooster/core/schemas';
import type { QueryResult } from './types';

/**
 * ADR 0072 (moving tasks to another org). CONTRACT STUB: the data-layer agent implements these;
 * the UI agent builds against the signatures.
 */

/**
 * The picker's preview (`GET /tasks/move-to-org/preview`, ADR 0072 §19). Online only (§21):
 * offline it errors, and the picker says it needs a connection. Idle while `orgId` is null or
 * `ids` is empty.
 */
export function useMoveToOrgPreview(
  _ids: readonly string[],
  _orgId: string | null,
): QueryResult<TaskMoveToOrgPreview> {
  return { data: undefined, isPending: true, error: null };
}

/**
 * The actor's groups in the target org for the picker's second step, in their order with the
 * Inbox first. Idle while `orgId` is null.
 */
export function useMoveTargetGroups(_orgId: string | null): QueryResult<readonly Group[]> {
  return { data: undefined, isPending: true, error: null };
}
