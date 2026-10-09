import {
  type Announcements,
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { normalGroups } from '@rooster/core/reducers';
import type { OrderingIntent, TaskMove } from '@rooster/core/schemas';
import {
  type KeyboardEvent,
  memo,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import {
  addRowId,
  addSubtaskRowId,
  type DropIndicator,
  groupIdOfRow,
  groupRowId,
  isGroupRowId,
  sectionRowId,
  useListUi,
} from '../../state/list-store';
import { announce } from './announcer';
import type { ListController } from './controller';
import { longPressSlopPx, suppressNextClick } from './gestures';
import { useListContext } from './list-context';
import { isNoopIntent } from './model/moves';
import { type GroupOrder, type Row, visibleOrder } from './model/rows';
import {
  currentSlot,
  type DropSlot,
  dropSlots,
  groupJump,
  indicatorSlot,
  isNoopSlot,
  slotIndicator,
  slotIntent,
} from './model/slots';

/** 02 §5: pointer drags start after 4 px; touch after a 350 ms long-press. */
export const dragDistancePx = 4;
export const touchDelayMs = 350;
/** Hovering a collapsed header this long opens it. */
export const hoverExpandMs = 600;
/** Auto-scroll zone at the scroll container's edges, and the top speed (px per frame). */
export const autoScrollZonePx = 64;
const autoScrollMaxSpeed = 18;

const silent: Announcements = {
  onDragStart: () => undefined,
  onDragMove: () => undefined,
  onDragOver: () => undefined,
  onDragEnd: () => undefined,
  onDragCancel: () => undefined,
};

/** The parent of a subtask row (subtasks only move among their siblings, 02 §5). */
function subtaskParent(rows: readonly Row[], id: string): string | null {
  const row = rows.find((r) => r.id === id);
  return row?.kind === 'task' ? row.parentId : null;
}

/**
 * The slots a drag works in: the groups' top-level rows, or for a subtask its siblings as one
 * pseudo-group keyed by the parent id.
 */
function dragOrder(rows: readonly Row[], ids: readonly string[]): GroupOrder[] {
  const parentId = ids.length === 1 ? subtaskParent(rows, ids[0] as string) : null;
  if (parentId === null) return visibleOrder(rows);
  const taskIds = rows
    .filter((r) => r.kind === 'task' && !r.draft && r.parentId === parentId)
    .map((r) => r.id);
  return [{ id: parentId, collapsed: false, taskIds }];
}

/** Applies a drop: a placement move, or a sibling reorder for a subtask. False: nothing moved. */
function commitDrop(
  controller: ListController,
  ids: string[],
  intent: TaskMove,
  subtask: boolean,
): boolean {
  if (subtask) {
    return controller.reorderSubtask(ids[0] as string, {
      afterId: intent.afterId ?? null,
      beforeId: intent.beforeId ?? null,
    });
  }
  return controller.moveTasks(ids, intent);
}

/**
 * The slot a pointer indicator stands for in a task or subtask drag. A subtask's pseudo-group
 * ends at its "+ Add subtask" row.
 */
function indicatorTarget(rows: readonly Row[], ids: readonly string[], drop: DropIndicator) {
  const order = dragOrder(rows, ids);
  const moving = new Set(ids);
  const parentId = subtaskParent(rows, ids[0] as string);
  const target =
    parentId !== null && drop.rowId === addSubtaskRowId(parentId)
      ? { rowId: addRowId(parentId), edge: drop.edge }
      : drop;
  return { order, moving, slot: indicatorSlot(order, moving, target) };
}

/**
 * The reorder a group drop asks for, or null when there is none: no target, or the group's own
 * place (directly before or after itself, 02 §5).
 */
function groupDropIntent(
  controller: ListController,
  groupId: string,
  drop: DropIndicator,
): OrderingIntent | null {
  const state = controller.state();
  if (!state || !isGroupRowId(drop.rowId)) return null;
  const target = groupIdOfRow(drop.rowId);
  const order = normalGroups(state).map((g) => g.id);
  const normals = order.filter((id) => id !== groupId);
  let intent: OrderingIntent | null;
  if (state.groups[target]?.kind === 'inbox') {
    intent = { afterId: null, beforeId: normals[0] ?? null };
  } else {
    const index = normals.indexOf(target);
    if (index < 0) return null;
    intent =
      drop.edge === 'before'
        ? { afterId: normals[index - 1] ?? null, beforeId: target }
        : { afterId: target, beforeId: normals[index + 1] ?? null };
  }
  return isNoopIntent(order, [groupId], intent) ? null : intent;
}

/** The tasks a drag of `id` carries: the whole selection when `id` is part of it. */
function draggedIds(controller: ListController, id: string): string[] {
  const selected = controller.ui().selected;
  if (subtaskParent(controller.rows(), id) !== null) return [id];
  if (selected[id]) {
    const ids = controller.selectedTaskIds();
    if (ids.length > 1) return ids;
  }
  return [id];
}

function positionText(
  controller: ListController,
  order: readonly GroupOrder[],
  moving: ReadonlySet<string>,
  slot: DropSlot,
) {
  const group = order[slot.groupIndex];
  const total = (group?.taskIds.filter((id) => !moving.has(id)).length ?? 0) + 1;
  const state = controller.state();
  const name = group ? (state?.groups[group.id]?.name ?? state?.tasks[group.id]?.title ?? '') : '';
  return { position: slot.index + 1, total, group: name };
}

/**
 * Keyboard drag on a focused handle (02 §5): Space lifts, ↑/↓ move one position, Ctrl+↑/↓
 * jump groups, Space drops, Esc cancels. Every step is announced.
 */
export function useKeyboardDragHandle(id: string) {
  const { t } = useTranslation('list');
  const { controller } = useListContext();

  const context = () => {
    const drag = controller.ui().keyboardDrag;
    const ids = drag?.ids ?? draggedIds(controller, id);
    const moving = new Set(ids);
    const order = dragOrder(controller.rows(), ids);
    return { drag, ids, moving, order, slots: dropSlots(order, moving) };
  };

  const show = (slot: number) => {
    const { ids, moving, order, slots } = context();
    const target = slots[slot];
    if (!target) return;
    controller.ui().set({
      keyboardDrag: { ids, slot },
      // Their own place gets no line: dropping there changes nothing (02 §5).
      drop: isNoopSlot(order, ids, target) ? null : slotIndicator(order, moving, target),
    });
    return target;
  };

  const end = () => controller.ui().set({ keyboardDrag: null, drop: null });
  const title = () => controller.task(id)?.title ?? '';

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const { drag, ids, moving, order, slots } = context();
    if (!drag) {
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        const slot = currentSlot(order, moving);
        const target = show(slot);
        if (target) {
          announce(
            t('dnd.pickedUp', {
              title: title(),
              ...positionText(controller, order, moving, target),
            }),
          );
        }
      }
      return;
    }
    event.stopPropagation();
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const step = event.key === 'ArrowUp' ? -1 : 1;
      const next =
        event.ctrlKey || event.metaKey
          ? groupJump(slots, drag.slot, step)
          : Math.max(0, Math.min(slots.length - 1, drag.slot + step));
      const target = show(next);
      if (target) {
        announce(
          t('dnd.over', { title: title(), ...positionText(controller, order, moving, target) }),
        );
      }
    } else if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      const target = slots[drag.slot];
      const intent =
        target && !isNoopSlot(order, ids, target) ? slotIntent(order, moving, target) : null;
      end();
      const subtask = subtaskParent(controller.rows(), id) !== null;
      if (!intent || !commitDrop(controller, ids, intent, subtask)) announce(t('dnd.cancelled'));
    } else if (event.key === 'Escape') {
      event.preventDefault();
      end();
      announce(t('dnd.cancelled'));
    } else if (event.key === 'Tab') {
      end();
      announce(t('dnd.cancelled'));
    }
  };

  const onBlur = () => {
    if (controller.ui().keyboardDrag) {
      end();
      announce(t('dnd.cancelled'));
    }
  };

  return { onKeyDown, onBlur };
}

/** The scrolling ancestor of the list (the app's `<main>`). */
function scrollParent(el: Element | null): HTMLElement | null {
  for (let node = el?.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
  }
  return document.scrollingElement as HTMLElement | null;
}

/**
 * Everyone's tasks (02 §11): the only drag there reassigns. Rows drop onto a section (an
 * assignee), never between rows; the section's header lights up.
 */
export interface AssignDrop {
  /** The section a row belongs to, or null where nothing can be dropped. */
  sectionOf: (row: Row) => string | null;
  /** Assigns the dragged tasks to the section's assignee; false when nothing changed. */
  commit: (ids: readonly string[], sectionId: string) => boolean;
}

interface DragSession {
  kind: 'task' | 'group' | 'subtask';
  /** An assign drag (Everyone's tasks): the section it started in and the one it is over. */
  assign: { from: string | null; to: string | null } | null;
  /** Task ids, or the dragged group id. */
  ids: string[];
  /** The pointer in viewport coordinates, from the input events themselves. */
  pointer: { x: number; y: number };
  start: { x: number; y: number };
  /** Where the row was grabbed, relative to its top-left corner: it stays under the pointer. */
  grab: { x: number; y: number };
  hover: { groupId: string; timer: ReturnType<typeof setTimeout> } | null;
  scroll: { frame: number; speed: number } | null;
  container: HTMLElement | null;
  width: number;
  touch: boolean;
  /** The farthest the pointer got from the start (a still long-press selects, 02 §13.2). */
  moved: number;
  /** Removes the session's window listeners. */
  detach: () => void;
}

function rowElementAt(x: number, y: number): HTMLElement | null {
  return (document.elementFromPoint(x, y)?.closest('[data-row-id]') as HTMLElement | null) ?? null;
}

/** Pointer-downs here never start a drag (02 §5: title input in Edit, checkbox, date cell). */
const noDragSelector =
  'input,[role="checkbox"],[data-no-drag],button:not([data-drag-handle]),[role="menu"],[role="dialog"]';

/** The row a pointer-down landed on, resolved before the sensor activates. */
function pressedRow(target: EventTarget | null): string | null {
  if (!(target instanceof Element) || target.closest(noDragSelector)) return null;
  const row = target.closest<HTMLElement>('[data-row-id]');
  const id = row?.dataset.rowId;
  if (!id || (row?.dataset.testid !== 'task-row' && row?.dataset.testid !== 'group-header')) {
    return null;
  }
  if (row?.dataset.draft || row?.dataset.inbox) return null;
  return id;
}

interface SurfaceProps {
  label: string;
  compact: boolean;
  rootRef: RefObject<HTMLDivElement | null>;
  pressed: RefObject<string | null>;
  enabled: boolean;
  /** Pointer (mouse) drags reorder; without it only touch long-presses start. */
  reorder: boolean;
  children: ReactNode;
}

/**
 * The whole tree grid is ONE dnd-kit draggable; the pressed row is remembered at pointer-down.
 * Per-row `useDraggable` would re-render all rows whenever any row mounts (dnd-kit rebuilds its
 * context), which breaks the 50 ms budget at 500 rows (AC-2.12).
 */
function DragSurface({
  label,
  compact,
  rootRef,
  pressed,
  enabled,
  reorder,
  children,
}: SurfaceProps) {
  const { setNodeRef, listeners } = useDraggable({ id: 'list', disabled: !enabled });
  const dragging = useListUi(
    (s) => s.drop !== null || s.dragging !== null || s.keyboardDrag !== null,
  );
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Touch drags are the TouchSensor's long-press; a touch moving 4 px is a scroll or a swipe.
    if (event.pointerType === 'touch' || !reorder) return;
    pressed.current = pressedRow(event.target);
    if (pressed.current) listeners?.onPointerDown?.(event);
  };
  const onTouchStart = (event: ReactTouchEvent<HTMLDivElement>) => {
    pressed.current = pressedRow(event.target);
    if (pressed.current) listeners?.onTouchStart?.(event);
  };
  return (
    <div
      ref={(node) => {
        setNodeRef(node);
        rootRef.current = node;
      }}
      role="treegrid"
      aria-label={label}
      aria-multiselectable
      data-list-root
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onTouchStart={onTouchStart}
      className={cn('flex flex-col', !compact && 'pb-16')}
    >
      {children}
    </div>
  );
}

/**
 * Pointer and touch drag and drop for the list (02 §5) behind one component, so dnd-kit stays
 * swappable. Drop targets come from the row under the pointer, not from droppable
 * registration, which keeps 500 rows cheap.
 */
export const ListDnd = memo(function ListDnd({
  rowsRef,
  label,
  rootRef,
  enabled = true,
  reorder = true,
  compact = false,
  onLongPress,
  assignDrop,
  children,
}: {
  rowsRef: RefObject<readonly Row[]>;
  label: string;
  rootRef: RefObject<HTMLDivElement | null>;
  enabled?: boolean;
  /**
   * Smart views (02 §10): no reordering, but a touch long-press still enters selection mode
   * (02 §13.2), so the sensor stays on without a lift, preview or drop target.
   */
  reorder?: boolean;
  /** The pane's subtask list: no trailing space for the bulk bar. */
  compact?: boolean;
  /** A touch long-press released without moving (02 §13.2: enters selection mode). */
  onLongPress?: ((rowId: string) => void) | undefined;
  /** Everyone's tasks: drags reassign instead of reordering (`reorder` is then ignored). */
  assignDrop?: AssignDrop | undefined;
  children: ReactNode;
}) {
  const assignRef = useRef(assignDrop);
  assignRef.current = assignDrop;
  const lifts = reorder || Boolean(assignDrop);
  const pressed = useRef<string | null>(null);
  const { t } = useTranslation('list');
  const { controller } = useListContext();
  const session = useRef<DragSession | null>(null);
  const [overlay, setOverlay] = useState<PreviewProps | null>(null);
  const layer = useRef<HTMLDivElement | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: dragDistancePx } }),
    useSensor(TouchSensor, { activationConstraint: { delay: touchDelayMs, tolerance: 5 } }),
  );
  const rowById = (id: string) => rowsRef.current.find((r) => r.id === id);

  const setDrop = (drop: DropIndicator | null) => {
    const current = controller.ui().drop;
    if (current?.rowId === drop?.rowId && current?.edge === drop?.edge) return;
    controller.ui().set({ drop });
  };

  const clearHover = (s: DragSession) => {
    if (s.hover) clearTimeout(s.hover.timer);
    s.hover = null;
  };

  const computeDrop = useCallback((s: DragSession) => {
    const el = rowElementAt(s.pointer.x, s.pointer.y);
    const rowId = el?.dataset.rowId;
    const row = rowId ? rowById(rowId) : undefined;
    if (!el || !row) return;
    if (s.assign) {
      const to = assignRef.current?.sectionOf(row) ?? null;
      s.assign.to = to !== null && to !== s.assign.from ? to : null;
      setDrop(s.assign.to ? { rowId: sectionRowId(s.assign.to), edge: 'inside' } : null);
      return;
    }
    const rect = el.getBoundingClientRect();
    const upper = s.pointer.y < rect.top + rect.height / 2;
    if (s.kind === 'group') {
      let candidate: DropIndicator | null = null;
      if (row.kind === 'group') {
        // Nothing goes above the Inbox.
        candidate = {
          rowId: row.id,
          edge: upper && row.group.kind !== 'inbox' ? 'before' : 'after',
        };
      } else if (row.kind === 'addGroup') {
        const last = [...rowsRef.current].reverse().find((r) => r.kind === 'group');
        if (last) candidate = { rowId: last.id, edge: 'after' };
      } else return;
      setDrop(
        candidate && groupDropIntent(controller, s.ids[0] as string, candidate) ? candidate : null,
      );
      return;
    }
    if (row.kind === 'group' && row.collapsed) {
      setDrop({ rowId: row.id, edge: 'inside' });
      const groupId = row.group.id;
      if (s.hover?.groupId !== groupId) {
        clearHover(s);
        s.hover = {
          groupId,
          timer: setTimeout(() => {
            const store = controller.ui();
            store.set({ hoverExpanded: { ...store.hoverExpanded, [groupId]: true } });
          }, hoverExpandMs),
        };
      }
      return;
    }
    clearHover(s);
    // Places equivalent to where the tasks already are (directly before or after themselves)
    // are not drop targets (02 §5).
    const offer = (candidate: DropIndicator | null) => {
      if (candidate) {
        const { order, slot } = indicatorTarget(rowsRef.current, s.ids, candidate);
        if (slot && isNoopSlot(order, s.ids, slot)) candidate = null;
      }
      setDrop(candidate);
    };
    if (s.kind === 'subtask') {
      const parentId = subtaskParent(rowsRef.current, s.ids[0] as string);
      if (row.kind === 'task' && !row.draft && row.parentId === parentId && row.id !== s.ids[0]) {
        offer({ rowId: row.id, edge: upper ? 'before' : 'after' });
      } else if (row.kind === 'addSubtask' && row.parentId === parentId) {
        offer({ rowId: row.id, edge: 'before' });
      } else setDrop(null);
      return;
    }
    if (row.kind === 'group') offer({ rowId: row.id, edge: 'after' });
    else if (row.kind === 'task') {
      if (s.ids.includes(row.id) || row.draft) setDrop(null);
      else offer({ rowId: row.id, edge: upper ? 'before' : 'after' });
    } else if (row.kind === 'add') offer({ rowId: row.id, edge: 'before' });
    else if (row.kind === 'hint') offer({ rowId: groupRowId(row.groupId), edge: 'after' });
    else {
      const lastGroup = [...rowsRef.current].reverse().find((r) => r.kind === 'group');
      if (lastGroup?.kind === 'group')
        offer({ rowId: addRowId(lastGroup.group.id), edge: 'before' });
    }
  }, []);

  const stopScroll = (s: DragSession) => {
    if (s.scroll) cancelAnimationFrame(s.scroll.frame);
    s.scroll = null;
  };

  const autoScroll = useCallback(
    (s: DragSession) => {
      const container = s.container;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const fromTop = s.pointer.y - rect.top;
      const fromBottom = rect.bottom - s.pointer.y;
      let speed = 0;
      if (fromTop < autoScrollZonePx)
        speed = -((autoScrollZonePx - Math.max(0, fromTop)) / autoScrollZonePx);
      else if (fromBottom < autoScrollZonePx) {
        speed = (autoScrollZonePx - Math.max(0, fromBottom)) / autoScrollZonePx;
      }
      speed *= autoScrollMaxSpeed;
      if (speed === 0) {
        stopScroll(s);
        return;
      }
      if (s.scroll) {
        s.scroll.speed = speed;
        return;
      }
      const tick = () => {
        if (!s.scroll || session.current !== s) return;
        container.scrollTop += s.scroll.speed;
        computeDrop(s);
        s.scroll.frame = requestAnimationFrame(tick);
      };
      s.scroll = { frame: requestAnimationFrame(tick), speed };
    },
    [computeDrop],
  );

  const finish = () => {
    const s = session.current;
    if (s) {
      s.detach();
      clearHover(s);
      stopScroll(s);
    }
    session.current = null;
    setOverlay(null);
    controller.ui().set({
      dragging: null,
      drop: null,
      dragCollapsed: false,
      hoverExpanded: {},
    });
  };

  const onDragStart = ({ active, activatorEvent }: DragStartEvent) => {
    const id = pressed.current;
    if (!id) return;
    const kind = isGroupRowId(id)
      ? 'group'
      : subtaskParent(rowsRef.current, id) !== null
        ? 'subtask'
        : 'task';
    const point = activatorEvent as PointerEvent | TouchEvent;
    const touch = 'touches' in point;
    const start = touch
      ? { x: point.touches[0]?.clientX ?? 0, y: point.touches[0]?.clientY ?? 0 }
      : { x: (point as PointerEvent).clientX, y: (point as PointerEvent).clientY };
    const ids = kind === 'group' ? [groupIdOfRow(id)] : draggedIds(controller, id);
    const root = rootRef.current;
    const rowRect = root
      ?.querySelector(`[data-row-id="${CSS.escape(id)}"]`)
      ?.getBoundingClientRect();
    const rect = rowRect ?? active.rect.current.initial;
    const pressedRowModel = rowById(id);
    const s: DragSession = {
      kind,
      assign:
        assignRef.current && kind === 'task' && pressedRowModel
          ? { from: assignRef.current.sectionOf(pressedRowModel), to: null }
          : null,
      ids,
      start,
      pointer: start,
      grab: rect ? { x: start.x - rect.left, y: start.y - rect.top } : { x: 0, y: 0 },
      hover: null,
      scroll: null,
      container: scrollParent(root),
      width: rect?.width ?? 0,
      touch,
      moved: 0,
      detach: () => undefined,
    };
    session.current = s;
    // The pointer comes from the input events, not from dnd-kit's delta: that delta also
    // carries the scroll since the drag began, which put the drop target off the pointer.
    const follow = (x: number, y: number) => {
      if (session.current !== s) return;
      s.pointer = { x, y };
      s.moved = Math.max(s.moved, Math.hypot(x - s.start.x, y - s.start.y));
      placeLayer(s);
      if (!lifts) return;
      computeDrop(s);
      autoScroll(s);
    };
    const onPointerMove = (event: PointerEvent) => follow(event.clientX, event.clientY);
    const onTouchMove = (event: TouchEvent) => {
      const point = event.touches[0];
      if (point) follow(point.clientX, point.clientY);
    };
    // Scrolling moves the rows under a still pointer.
    const onScroll = () => {
      if (session.current === s && lifts) computeDrop(s);
    };
    const options = { capture: true, passive: true };
    if (touch) window.addEventListener('touchmove', onTouchMove, options);
    else window.addEventListener('pointermove', onPointerMove, options);
    window.addEventListener('scroll', onScroll, options);
    s.detach = () => {
      window.removeEventListener('touchmove', onTouchMove, options);
      window.removeEventListener('pointermove', onPointerMove, options);
      window.removeEventListener('scroll', onScroll, options);
    };
    if (touch) navigator.vibrate?.(10);
    if (!lifts) return;
    const state = controller.state();
    const name =
      kind === 'group'
        ? (state?.groups[ids[0] as string]?.name ?? '')
        : (state?.tasks[id]?.title ?? '');
    setOverlay({
      kind: kind === 'group' ? 'group' : 'task',
      title: name,
      count: ids.length,
      width: s.width,
      height: rect?.height ?? 0,
      origin: s.grab,
      touch,
    });
    controller.ui().set({
      dragging: kind === 'group' ? [id] : ids,
      dragCollapsed: kind === 'group',
      popover: null,
    });
    if (s.assign) {
      announce(t('dnd.pickedUpAssign', { title: name, count: ids.length }));
    } else if (kind !== 'group') {
      const order = dragOrder(rowsRef.current, ids);
      const moving = new Set(ids);
      const slot = dropSlots(order, moving)[currentSlot(order, moving)];
      if (slot) {
        announce(
          t('dnd.pickedUp', { title: name, ...positionText(controller, order, moving, slot) }),
        );
      }
    } else {
      announce(t('dnd.pickedUpGroup', { group: name }));
    }
  };

  const onDragEnd = (_event: DragEndEvent) => {
    const s = session.current;
    if (s?.touch) suppressNextClick(s.pointer.x, s.pointer.y);
    if (s?.touch && s.kind === 'task' && s.moved < longPressSlopPx && onLongPress) {
      const id = pressed.current;
      finish();
      if (id) onLongPress(id);
      return;
    }
    if (!lifts) {
      finish();
      return;
    }
    if (s?.assign) {
      const to = s.assign.to;
      finish();
      if (!to || !assignRef.current?.commit(s.ids, to)) announce(t('dnd.cancelled'));
      return;
    }
    const drop = controller.ui().drop;
    if (!s || !drop) {
      finish();
      announce(t('dnd.cancelled'));
      return;
    }
    if (s.kind === 'group') {
      const groupId = s.ids[0] as string;
      const intent = groupDropIntent(controller, groupId, drop);
      finish();
      if (!intent || !controller.moveGroup(groupId, intent)) announce(t('dnd.cancelled'));
      return;
    }
    const { order, moving, slot } = indicatorTarget(rowsRef.current, s.ids, drop);
    const intent = slot && !isNoopSlot(order, s.ids, slot) ? slotIntent(order, moving, slot) : null;
    // A group opened by hovering stays open once something lands in it.
    const opened = intent && controller.ui().hoverExpanded[intent.groupId];
    finish();
    if (intent && opened) controller.setCollapsed(intent.groupId, false);
    if (!intent || !commitDrop(controller, s.ids, intent, s.kind === 'subtask')) {
      announce(t('dnd.cancelled'));
    }
  };

  /** Puts the preview's grab point under the pointer (the layer is `fixed` at the origin). */
  const placeLayer = (s: DragSession) => {
    const el = layer.current;
    if (!el) return;
    el.style.transform = `translate3d(${s.pointer.x - s.grab.x}px, ${s.pointer.y - s.grab.y}px, 0)`;
  };

  useEffect(() => () => finish(), []);

  return (
    <DndContext
      sensors={sensors}
      autoScroll={false}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        finish();
        announce(t('dnd.cancelled'));
      }}
      accessibility={{
        announcements: silent,
        screenReaderInstructions: { draggable: t('dnd.instructions') },
      }}
    >
      <DragSurface
        label={label}
        compact={compact}
        rootRef={rootRef}
        pressed={pressed}
        enabled={enabled}
        reorder={lifts}
      >
        {children}
      </DragSurface>
      {overlay &&
        createPortal(
          // Not dnd-kit's DragOverlay: it is placed and sized from the active node, which is the
          // whole grid here, so the preview sat at the grid's top. Portalled to <body>, so
          // `fixed` never resolves against a transformed or contained ancestor.
          <div
            ref={(node) => {
              layer.current = node;
              if (node && session.current) placeLayer(session.current);
            }}
            aria-hidden
            data-testid="drag-layer"
            className="pointer-events-none fixed top-0 left-0 z-(--z-drag)"
          >
            <DragPreview {...overlay} />
          </div>,
          document.body,
        )}
    </DndContext>
  );
});

interface PreviewProps {
  kind: 'task' | 'group';
  title: string;
  count: number;
  /** The original row's size. */
  width: number;
  height: number;
  /** The grab point: the 2° tilt turns around it, so it stays under the pointer. */
  origin: { x: number; y: number };
  touch: boolean;
}

function DragPreview({ kind, title, count, width, height, origin, touch }: PreviewProps) {
  return (
    <div
      data-testid="drag-preview"
      className={cn('relative opacity-95', !touch && 'rotate-2')}
      style={{
        width: width > 0 ? width : undefined,
        transformOrigin: `${origin.x}px ${origin.y}px`,
      }}
    >
      {count > 1 && (
        <>
          <span
            aria-hidden
            className="absolute inset-0 translate-x-2 translate-y-2 rounded-sm bg-bg-elevated shadow-md"
          />
          <span
            aria-hidden
            className="absolute inset-0 translate-x-1 translate-y-1 rounded-sm bg-bg-elevated shadow-md"
          />
        </>
      )}
      <div
        className={cn(
          'relative flex items-center gap-3 rounded-sm bg-bg-elevated px-3 shadow-lg',
          kind === 'group'
            ? 'h-group text-group max-tablet:h-group-mobile'
            : 'h-row text-base max-tablet:h-row-mobile max-tablet:text-md',
        )}
        style={{ minHeight: height > 0 ? height : undefined }}
      >
        {kind === 'task' && (
          <span className="ms-6 size-checkbox shrink-0 rounded-full border-(length:--border-check) border-border-strong" />
        )}
        <span className="min-w-0 truncate">{title}</span>
        {count > 1 && (
          <span className="ms-auto inline-flex h-chip min-w-5 items-center justify-center rounded-full bg-bg-accent px-1.5 text-xs font-semibold text-text-on-accent tabular-nums">
            {count}
          </span>
        )}
      </div>
    </div>
  );
}
