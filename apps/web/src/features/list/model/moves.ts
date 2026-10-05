import type { OrderingIntent, TaskMove } from '@rooster/core/schemas';
import type { GroupOrder } from './rows';

/** 02 §5 keyboard moves. */
export type KeyboardMove =
  | 'up'
  | 'down'
  | 'previousGroupEnd'
  | 'nextGroupStart'
  | 'groupTop'
  | 'groupBottom';

/** The intent placing the moving tasks at `index` of `group`'s remaining (non-moving) tasks. */
export function intentAtIndex(
  group: GroupOrder,
  moving: ReadonlySet<string>,
  index: number,
): TaskMove {
  const rest = group.taskIds.filter((id) => !moving.has(id));
  return {
    groupId: group.id,
    afterId: rest[index - 1] ?? null,
    beforeId: rest[index] ?? null,
  };
}

function neighbourGroup(
  order: readonly GroupOrder[],
  from: number,
  step: 1 | -1,
): GroupOrder | undefined {
  for (let i = from + step; i >= 0 && i < order.length; i += step) {
    const group = order[i] as GroupOrder;
    // Moving into a collapsed group would hide the task; skip it (02 §5 table: visible groups).
    if (!group.collapsed) return group;
  }
  return undefined;
}

/**
 * Where a keyboard move sends the selected tasks (selection-aware: the block keeps its
 * order and lands together). Null when there is nowhere to go.
 */
export function keyboardMoveTarget(
  order: readonly GroupOrder[],
  ids: readonly string[],
  move: KeyboardMove,
): TaskMove | null {
  const moving = new Set(ids);
  const located = order.flatMap((group, groupIndex) =>
    group.taskIds.flatMap((id, index) => (moving.has(id) ? [{ groupIndex, index }] : [])),
  );
  const first = located[0];
  const last = located.at(-1);
  if (!first || !last) return null;
  const firstGroup = order[first.groupIndex] as GroupOrder;
  const lastGroup = order[last.groupIndex] as GroupOrder;
  const restOf = (group: GroupOrder) => group.taskIds.filter((id) => !moving.has(id));
  /** Non-moving tasks above the first moving one, in its group. */
  const aboveFirst = firstGroup.taskIds.slice(0, first.index).filter((id) => !moving.has(id));
  const belowLast = lastGroup.taskIds.slice(last.index + 1).filter((id) => !moving.has(id));

  switch (move) {
    case 'up': {
      if (aboveFirst.length > 0) return intentAtIndex(firstGroup, moving, aboveFirst.length - 1);
      const previous = neighbourGroup(order, first.groupIndex, -1);
      return previous ? intentAtIndex(previous, moving, restOf(previous).length) : null;
    }
    case 'down': {
      if (belowLast.length > 0) {
        const rest = restOf(lastGroup);
        return intentAtIndex(lastGroup, moving, rest.indexOf(belowLast[0] as string) + 1);
      }
      const next = neighbourGroup(order, last.groupIndex, 1);
      return next ? intentAtIndex(next, moving, 0) : null;
    }
    case 'previousGroupEnd': {
      const previous = neighbourGroup(order, first.groupIndex, -1);
      return previous ? intentAtIndex(previous, moving, restOf(previous).length) : null;
    }
    case 'nextGroupStart': {
      const next = neighbourGroup(order, last.groupIndex, 1);
      return next ? intentAtIndex(next, moving, 0) : null;
    }
    case 'groupTop':
      return aboveFirst.length === 0 ? null : intentAtIndex(firstGroup, moving, 0);
    case 'groupBottom':
      return belowLast.length === 0
        ? null
        : intentAtIndex(lastGroup, moving, restOf(lastGroup).length);
  }
}

/** Group reorder by one step (Ctrl+↑/↓ on a header); the Inbox is excluded by the caller. */
export function groupStepTarget(
  normalIds: readonly string[],
  groupId: string,
  step: 1 | -1,
): OrderingIntent | null {
  const index = normalIds.indexOf(groupId);
  const target = index + step;
  if (index < 0 || target < 0 || target >= normalIds.length) return null;
  const rest = normalIds.filter((id) => id !== groupId);
  return { afterId: rest[target - 1] ?? null, beforeId: rest[target] ?? null };
}
