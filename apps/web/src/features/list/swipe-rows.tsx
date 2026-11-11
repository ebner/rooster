import type { SwipeAction } from '@rooster/core/schemas';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { SwipeReveal, type SwipeRevealAction } from '../../ui/swipe-reveal';
import type { ListController } from './controller';
import {
  clickSuppressed,
  motionMs,
  suppressNextClick,
  swipeActionFor,
  swipeCommitShare,
  swipeCommits,
  swipeResistance,
  swipeSlopPx,
} from './gestures';

export interface SwipePrefs {
  swipeLeft: SwipeAction;
  swipeRight: SwipeAction;
}

interface Reveal {
  rowId: string;
  top: number;
  height: number;
  action: SwipeRevealAction;
  side: 'start' | 'end';
  armed: boolean;
}

interface Gesture {
  pointerId: number;
  rowId: string;
  row: HTMLElement;
  x0: number;
  y0: number;
  lastX: number;
  lastT: number;
  velocity: number;
  dx: number;
  phase: 'pending' | 'swiping' | 'scroll';
  armed: boolean;
  action: SwipeRevealAction | null;
  /** In Upcoming (ADR 0068): a Move swipe only stretches, as a direction without an action. */
  upcoming: boolean;
}

export interface SwipeRowsProps {
  /** The tree grid (the list root). */
  rootRef: RefObject<HTMLElement | null>;
  /** The positioned wrapper the reveal is drawn in (around the tree grid). */
  layerRef: RefObject<HTMLElement | null>;
  controller: ListController;
  enabled: boolean;
  prefs: SwipePrefs;
  /** The action to run once the row has settled. */
  onCommit: (rowId: string, action: SwipeRevealAction) => void;
}

function resetRow(row: HTMLElement, animate: boolean): void {
  row.style.transition = animate ? 'transform var(--dur-slow) var(--ease-standard)' : 'none';
  row.style.transform = '';
  const done = () => {
    row.style.transition = '';
    row.style.zIndex = '';
    row.style.backgroundColor = '';
  };
  if (animate) setTimeout(done, motionMs('slow'));
  else done();
}

/**
 * Swipe actions on task rows (02 §13.2), one delegated pointer handler for the whole list. A
 * touch that travels sideways first becomes a swipe (rows are `touch-action: pan-y`, so
 * vertical pans stay native scrolling); one that waits 350 ms belongs to dnd-kit's long-press.
 * The row follows the finger through inline styles, the action's reveal sits behind it, and a
 * release past 30 % of the width (or a fling) commits. Renders the reveal only.
 */
export function SwipeRows({
  rootRef,
  layerRef,
  controller,
  enabled,
  prefs,
  onCommit,
}: SwipeRowsProps) {
  const { t } = useTranslation('mobile');
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const live = useRef({ enabled, prefs, onCommit });
  live.current = { enabled, prefs, onCommit };

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let gesture: Gesture | null = null;

    const show = (g: Gesture) => {
      const layer = layerRef.current;
      if (!layer || !g.action) {
        setReveal(null);
        return;
      }
      const rowRect = g.row.getBoundingClientRect();
      const layerRect = layer.getBoundingClientRect();
      const next: Reveal = {
        rowId: g.rowId,
        top: rowRect.top - layerRect.top,
        height: rowRect.height,
        action: g.action,
        side: g.dx >= 0 ? 'start' : 'end',
        armed: g.armed,
      };
      setReveal((current) =>
        current &&
        current.rowId === next.rowId &&
        current.action === next.action &&
        current.side === next.side &&
        current.armed === next.armed
          ? current
          : next,
      );
    };

    const onDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' || !event.isPrimary || !live.current.enabled) return;
      const target = event.target as Element | null;
      if (!target || target.closest('input,textarea,[contenteditable="true"]')) return;
      const row = target.closest<HTMLElement>('[data-testid="task-row"]');
      const rowId = row?.dataset.rowId;
      if (!row || !rowId || row.dataset.draft) return;
      gesture = {
        pointerId: event.pointerId,
        rowId,
        row,
        x0: event.clientX,
        y0: event.clientY,
        lastX: event.clientX,
        lastT: event.timeStamp,
        velocity: 0,
        dx: 0,
        phase: 'pending',
        armed: false,
        action: null,
        upcoming: row.dataset.upcoming !== undefined,
      };
    };

    const onMove = (event: PointerEvent) => {
      const g = gesture;
      if (!g || g.pointerId !== event.pointerId || g.phase === 'scroll') return;
      const dx = event.clientX - g.x0;
      const dy = event.clientY - g.y0;
      if (g.phase === 'pending') {
        const store = controller.ui();
        if (store.dragging || store.keyboardDrag) {
          gesture = null;
          return;
        }
        if (Math.abs(dy) > swipeSlopPx && Math.abs(dy) >= Math.abs(dx)) {
          g.phase = 'scroll';
          return;
        }
        if (Math.abs(dx) <= swipeSlopPx || Math.abs(dx) < Math.abs(dy) * 1.2) return;
        g.phase = 'swiping';
        try {
          root.setPointerCapture(event.pointerId);
        } catch {
          // Synthetic or already released pointers cannot be captured; moves still bubble.
        }
        g.row.style.zIndex = '1';
        g.row.style.backgroundColor = 'var(--color-bg-app)';
      }
      const dt = Math.max(1, event.timeStamp - g.lastT);
      g.velocity = (event.clientX - g.lastX) / dt;
      g.lastX = event.clientX;
      g.lastT = event.timeStamp;
      g.dx = dx;
      const swiped = swipeActionFor(dx, live.current.prefs);
      const action = g.upcoming && swiped === 'move' ? null : swiped;
      const width = g.row.getBoundingClientRect().width;
      const offset = action ? dx : dx * swipeResistance;
      const armed = action !== null && Math.abs(dx) >= width * swipeCommitShare;
      if (armed && !g.armed) navigator.vibrate?.(10);
      g.armed = armed;
      g.action = action;
      g.row.style.transition = 'none';
      g.row.style.transform = `translateX(${offset}px)`;
      show(g);
    };

    const finish = (event: PointerEvent, cancelled: boolean) => {
      const g = gesture;
      if (!g || g.pointerId !== event.pointerId) return;
      gesture = null;
      if (g.phase !== 'swiping') return;
      suppressNextClick(event.clientX, event.clientY, g.row);
      const width = g.row.getBoundingClientRect().width;
      const commit =
        !cancelled && g.action !== null && swipeCommits(g.dx, g.velocity, width) ? g.action : null;
      if (!commit) {
        resetRow(g.row, true);
        setTimeout(() => setReveal(null), motionMs('slow'));
        return;
      }
      const { row, rowId } = g;
      if (commit === 'complete' || commit === 'delete') {
        // The row leaves the way it was pushed, then completes (and collapses) or goes.
        row.style.transition = 'transform var(--dur-slow) var(--ease-exit)';
        row.style.transform = `translateX(${g.dx >= 0 ? width : -width}px)`;
        setTimeout(() => {
          live.current.onCommit(rowId, commit);
          setReveal(null);
          // A row that stays (show completed) slides back; a collapsing one is gone by then.
          setTimeout(() => resetRow(row, row.isConnected), motionMs('slow'));
        }, motionMs('slow'));
      } else {
        resetRow(row, true);
        setTimeout(() => {
          setReveal(null);
          live.current.onCommit(rowId, commit);
        }, motionMs('slow'));
      }
    };

    const onUp = (event: PointerEvent) => finish(event, false);
    const onCancel = (event: PointerEvent) => finish(event, true);
    const onClick = (event: MouseEvent) => {
      if (!clickSuppressed(event)) return;
      event.stopPropagation();
      event.preventDefault();
    };

    root.addEventListener('pointerdown', onDown);
    root.addEventListener('pointermove', onMove);
    root.addEventListener('pointerup', onUp);
    root.addEventListener('pointercancel', onCancel);
    root.addEventListener('click', onClick, true);
    return () => {
      root.removeEventListener('pointerdown', onDown);
      root.removeEventListener('pointermove', onMove);
      root.removeEventListener('pointerup', onUp);
      root.removeEventListener('pointercancel', onCancel);
      root.removeEventListener('click', onClick, true);
    };
  }, [rootRef, layerRef, controller]);

  const layer = layerRef.current;
  if (!reveal || !layer) return null;
  // Drawn inside the layer: `top` is measured from it, so it must be the offset parent.
  return createPortal(
    <SwipeReveal
      action={reveal.action}
      side={reveal.side}
      armed={reveal.armed}
      label={t(`swipe.${reveal.action}`)}
      className="pointer-events-none absolute inset-x-0"
      style={{ top: reveal.top, height: reveal.height }}
    />,
    layer,
  );
}
