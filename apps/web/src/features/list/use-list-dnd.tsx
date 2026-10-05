import {
  type Announcements,
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  DragOverlay,
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
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import {
  addRowId,
  addSubtaskRowId,
  type DropIndicator,
  groupIdOfRow,
  groupRowId,
  isGroupRowId,
  useListUi,
} from '../../state/list-store';
import { announce } from './announcer';
import type { ListController } from './controller';
import { useListContext } from './list-context';
import { type GroupOrder, type Row, visibleOrder } from './model/rows';
import {
  currentSlot,
  type DropSlot,
  dropSlots,
  groupJump,
  indicatorSlot,
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

/** Applies a drop: a placement move, or a sibling reorder for a subtask. */
function commitDrop(controller: ListController, ids: string[], intent: TaskMove, subtask: boolean) {
  if (subtask) {
    controller.reorderSubtask(ids[0] as string, {
      afterId: intent.afterId ?? null,
      beforeId: intent.beforeId ?? null,
    });
  } else controller.moveTasks(ids, intent);
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
      drop: slotIndicator(order, moving, target),
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
      const intent = target ? slotIntent(order, moving, target) : null;
      end();
      if (intent)
        commitDrop(controller, ids, intent, subtaskParent(controller.rows(), id) !== null);
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

interface DragSession {
  kind: 'task' | 'group' | 'subtask';
  /** Task ids, or the dragged group id. */
  ids: string[];
  pointer: { x: number; y: number };
  start: { x: number; y: number };
  hover: { groupId: string; timer: ReturnType<typeof setTimeout> } | null;
  scroll: { frame: number; speed: number } | null;
  container: HTMLElement | null;
  width: number;
  touch: boolean;
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
  children: ReactNode;
}

/**
 * The whole tree grid is ONE dnd-kit draggable; the pressed row is remembered at pointer-down.
 * Per-row `useDraggable` would re-render all rows whenever any row mounts (dnd-kit rebuilds its
 * context), which breaks the 50 ms budget at 500 rows (AC-2.12).
 */
function DragSurface({ label, compact, rootRef, pressed, enabled, children }: SurfaceProps) {
  const { setNodeRef, listeners } = useDraggable({ id: 'list', disabled: !enabled });
  const dragging = useListUi(
    (s) => s.drop !== null || s.dragging !== null || s.keyboardDrag !== null,
  );
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
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
  compact = false,
  children,
}: {
  rowsRef: RefObject<readonly Row[]>;
  label: string;
  rootRef: RefObject<HTMLDivElement | null>;
  enabled?: boolean;
  /** The pane's subtask list: no trailing space for the bulk bar. */
  compact?: boolean;
  children: ReactNode;
}) {
  const pressed = useRef<string | null>(null);
  const { t } = useTranslation('list');
  const { controller } = useListContext();
  const session = useRef<DragSession | null>(null);
  const [overlay, setOverlay] = useState<{
    kind: 'task' | 'group';
    title: string;
    count: number;
    width: number;
    touch: boolean;
  } | null>(null);
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
    const rect = el.getBoundingClientRect();
    const upper = s.pointer.y < rect.top + rect.height / 2;
    if (s.kind === 'group') {
      if (row.kind === 'group') {
        // Nothing goes above the Inbox.
        setDrop({ rowId: row.id, edge: upper && row.group.kind !== 'inbox' ? 'before' : 'after' });
      } else if (row.kind === 'addGroup') {
        const last = [...rowsRef.current].reverse().find((r) => r.kind === 'group');
        if (last) setDrop({ rowId: last.id, edge: 'after' });
      }
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
    if (s.kind === 'subtask') {
      const parentId = subtaskParent(rowsRef.current, s.ids[0] as string);
      if (row.kind === 'task' && !row.draft && row.parentId === parentId && row.id !== s.ids[0]) {
        setDrop({ rowId: row.id, edge: upper ? 'before' : 'after' });
      } else if (row.kind === 'addSubtask' && row.parentId === parentId) {
        setDrop({ rowId: row.id, edge: 'before' });
      } else setDrop(null);
      return;
    }
    if (row.kind === 'group') setDrop({ rowId: row.id, edge: 'after' });
    else if (row.kind === 'task') {
      if (s.ids.includes(row.id) || row.draft) setDrop(null);
      else setDrop({ rowId: row.id, edge: upper ? 'before' : 'after' });
    } else if (row.kind === 'add') setDrop({ rowId: row.id, edge: 'before' });
    else if (row.kind === 'hint') setDrop({ rowId: groupRowId(row.groupId), edge: 'after' });
    else {
      const lastGroup = [...rowsRef.current].reverse().find((r) => r.kind === 'group');
      if (lastGroup?.kind === 'group')
        setDrop({ rowId: addRowId(lastGroup.group.id), edge: 'before' });
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
    session.current = {
      kind,
      ids,
      start,
      pointer: start,
      hover: null,
      scroll: null,
      container: scrollParent(root),
      width: active.rect.current.initial?.width ?? 0,
      touch,
    };
    if (touch) navigator.vibrate?.(10);
    const state = controller.state();
    const name =
      kind === 'group'
        ? (state?.groups[ids[0] as string]?.name ?? '')
        : (state?.tasks[id]?.title ?? '');
    setOverlay({
      kind: kind === 'group' ? 'group' : 'task',
      title: name,
      count: ids.length,
      width: session.current.width,
      touch,
    });
    controller.ui().set({
      dragging: kind === 'group' ? [id] : ids,
      dragCollapsed: kind === 'group',
      popover: null,
    });
    if (kind !== 'group') {
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

  const onDragMove = ({ delta }: DragMoveEvent) => {
    const s = session.current;
    if (!s) return;
    s.pointer = { x: s.start.x + delta.x, y: s.start.y + delta.y };
    computeDrop(s);
    autoScroll(s);
  };

  const onDragEnd = (_event: DragEndEvent) => {
    const s = session.current;
    const drop = controller.ui().drop;
    if (!s || !drop) {
      finish();
      announce(t('dnd.cancelled'));
      return;
    }
    if (s.kind === 'group') {
      const intent = groupIntent(s.ids[0] as string, drop);
      finish();
      if (intent) controller.moveGroup(s.ids[0] as string, intent);
      return;
    }
    const order = dragOrder(rowsRef.current, s.ids);
    const moving = new Set(s.ids);
    const parentId = s.kind === 'subtask' ? (order[0]?.id ?? '') : null;
    // The pseudo-group's "+ Add subtask" row stands for the end of the siblings.
    const target =
      parentId !== null && drop.rowId === addSubtaskRowId(parentId)
        ? { rowId: addRowId(parentId), edge: drop.edge }
        : drop;
    const slot = indicatorSlot(order, moving, target);
    const intent = slot ? slotIntent(order, moving, slot) : null;
    // A group opened by hovering stays open once something lands in it.
    const opened = intent && controller.ui().hoverExpanded[intent.groupId];
    finish();
    if (intent && opened) controller.setCollapsed(intent.groupId, false);
    if (intent) commitDrop(controller, s.ids, intent, s.kind === 'subtask');
    else announce(t('dnd.cancelled'));
  };

  const groupIntent = (groupId: string, drop: DropIndicator): OrderingIntent | null => {
    const state = controller.state();
    if (!state || !isGroupRowId(drop.rowId)) return null;
    const target = groupIdOfRow(drop.rowId);
    const normals = normalGroups(state).filter((g) => g.id !== groupId);
    if (state.groups[target]?.kind === 'inbox') {
      return { afterId: null, beforeId: normals[0]?.id ?? null };
    }
    const index = normals.findIndex((g) => g.id === target);
    if (index < 0) return null;
    return drop.edge === 'before'
      ? { afterId: normals[index - 1]?.id ?? null, beforeId: target }
      : { afterId: target, beforeId: normals[index + 1]?.id ?? null };
  };

  useEffect(() => () => finish(), []);

  return (
    <DndContext
      sensors={sensors}
      autoScroll={false}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
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
      >
        {children}
      </DragSurface>
      <DragOverlay dropAnimation={null} zIndex={70} className="pointer-events-none">
        {overlay && <DragPreview {...overlay} />}
      </DragOverlay>
    </DndContext>
  );
});

function DragPreview({
  kind,
  title,
  count,
  width,
  touch,
}: {
  kind: 'task' | 'group';
  title: string;
  count: number;
  width: number;
  touch: boolean;
}) {
  return (
    <div
      className={cn('relative opacity-95', !touch && 'rotate-2')}
      style={{ width: width > 0 ? width : undefined }}
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
          kind === 'group' ? 'h-group text-group' : 'h-row text-base',
        )}
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
