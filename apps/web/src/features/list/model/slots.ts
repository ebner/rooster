import type { TaskMove } from '@rooster/core/schemas';
import { type DropIndicator, groupRowId } from '../../../state/list-store';
import { intentAtIndex, isNoopIntent } from './moves';
import type { GroupOrder } from './rows';

/** One insertion point for moving tasks: index `index` among `group`'s remaining tasks. */
export interface DropSlot {
  groupIndex: number;
  index: number;
}

/**
 * Every place the moving tasks can land, top to bottom (keyboard drag, 02 §5). A collapsed
 * group offers one slot (its top), as dropping on its header does.
 */
export function dropSlots(order: readonly GroupOrder[], moving: ReadonlySet<string>): DropSlot[] {
  const slots: DropSlot[] = [];
  order.forEach((group, groupIndex) => {
    const count = group.collapsed ? 0 : group.taskIds.filter((id) => !moving.has(id)).length;
    for (let index = 0; index <= count; index++) slots.push({ groupIndex, index });
  });
  return slots;
}

/** The slot the moving tasks currently occupy (their first task's position). */
export function currentSlot(order: readonly GroupOrder[], moving: ReadonlySet<string>): number {
  const slots = dropSlots(order, moving);
  for (const [groupIndex, group] of order.entries()) {
    const at = group.taskIds.findIndex((id) => moving.has(id));
    if (at < 0) continue;
    const index = group.taskIds.slice(0, at).filter((id) => !moving.has(id)).length;
    return Math.max(
      0,
      slots.findIndex((s) => s.groupIndex === groupIndex && s.index === index),
    );
  }
  return 0;
}

/** The first slot of the previous (-1) or next (+1) group, for Ctrl+↑/↓ while dragging. */
export function groupJump(slots: readonly DropSlot[], from: number, step: 1 | -1): number {
  const group = slots[from]?.groupIndex;
  if (group === undefined) return from;
  const target = group + step;
  const index = slots.findIndex((s) => s.groupIndex === target);
  return index < 0 ? from : index;
}

/** Where the indicator line is drawn for a slot. */
export function slotIndicator(
  order: readonly GroupOrder[],
  moving: ReadonlySet<string>,
  slot: DropSlot,
): DropIndicator | null {
  const group = order[slot.groupIndex];
  if (!group) return null;
  const rest = group.taskIds.filter((id) => !moving.has(id));
  if (group.collapsed || rest.length === 0) return { rowId: groupRowId(group.id), edge: 'inside' };
  const below = rest[slot.index];
  if (below) return { rowId: below, edge: 'before' };
  return { rowId: rest.at(-1) as string, edge: 'after' };
}

export function slotIntent(
  order: readonly GroupOrder[],
  moving: ReadonlySet<string>,
  slot: DropSlot,
): TaskMove | null {
  const group = order[slot.groupIndex];
  return group ? intentAtIndex(group, moving, slot.index) : null;
}

/** The drop indicator's slot (pointer drag): the inverse of `slotIndicator`. */
export function indicatorSlot(
  order: readonly GroupOrder[],
  moving: ReadonlySet<string>,
  indicator: DropIndicator,
): DropSlot | null {
  for (const [groupIndex, group] of order.entries()) {
    if (indicator.rowId === groupRowId(group.id)) return { groupIndex, index: 0 };
    if (indicator.rowId === `add:${group.id}`) {
      return { groupIndex, index: group.taskIds.filter((id) => !moving.has(id)).length };
    }
    const rest = group.taskIds.filter((id) => !moving.has(id));
    const at = rest.indexOf(indicator.rowId);
    if (at >= 0) return { groupIndex, index: indicator.edge === 'after' ? at + 1 : at };
  }
  return null;
}

/**
 * True when dropping `ids` at `slot` would leave them where they are: directly before or after
 * themselves (02 §5). No drop line is drawn there and dropping sends nothing.
 */
export function isNoopSlot(
  order: readonly GroupOrder[],
  ids: readonly string[],
  slot: DropSlot,
): boolean {
  const group = order[slot.groupIndex];
  if (!group) return false;
  return isNoopIntent(group.taskIds, ids, intentAtIndex(group, new Set(ids), slot.index));
}
