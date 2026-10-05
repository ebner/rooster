import type { OrgReorderIntent } from '../../data/types';

/**
 * The ordering intent for moving `ids[from]` to index `to` (06 §1): `afterId` is
 * the item that ends up directly above it, `beforeId` the one directly below.
 * Returns null when nothing moves.
 */
export function reorderIntent(
  ids: readonly string[],
  from: number,
  to: number,
): OrgReorderIntent | null {
  const orgId = ids[from];
  if (orgId === undefined || from === to || to < 0 || to >= ids.length) return null;
  const order = ids.filter((_, index) => index !== from);
  order.splice(to, 0, orgId);
  return { orgId, afterId: order[to - 1] ?? null, beforeId: order[to + 1] ?? null };
}
