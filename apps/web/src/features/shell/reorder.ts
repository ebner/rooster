import type { OrgReorderIntent } from '../../data/types';

export interface MoveIntent {
  id: string;
  afterId: string | null;
  beforeId: string | null;
}

/**
 * The ordering intent for moving `ids[from]` to index `to` (06 §1): `afterId` is the item that
 * ends up directly above it, `beforeId` the one directly below. Null when nothing moves.
 */
export function moveIntent(ids: readonly string[], from: number, to: number): MoveIntent | null {
  const id = ids[from];
  if (id === undefined || from === to || to < 0 || to >= ids.length) return null;
  const order = ids.filter((_, index) => index !== from);
  order.splice(to, 0, id);
  return { id, afterId: order[to - 1] ?? null, beforeId: order[to + 1] ?? null };
}

/** `moveIntent` for the sidebar's orgs (`POST /me/orgs/reorder`). */
export function reorderIntent(
  ids: readonly string[],
  from: number,
  to: number,
): OrgReorderIntent | null {
  const intent = moveIntent(ids, from, to);
  return intent && { orgId: intent.id, afterId: intent.afterId, beforeId: intent.beforeId };
}
