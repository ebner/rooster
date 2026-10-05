import { type PointerEvent, type RefObject, useRef } from 'react';

/** Released past this share of the surface's height, a downward drag dismisses. */
export const dismissShare = 0.25;
/** px/ms: a flick this fast dismisses regardless of distance. */
export const flingVelocity = 0.5;

interface DragState {
  pointerId: number;
  startY: number;
  lastY: number;
  lastT: number;
  velocity: number;
}

/**
 * Swipe down to dismiss a sheet (02 §13.4, 03 §3.11): pointer handlers for the drag handle
 * area. The surface follows the finger; a release past a quarter of its height, or a
 * downward flick, dismisses, anything else springs back. Writes styles directly, so a drag
 * never re-renders React.
 */
export function useDragDismiss(
  surface: RefObject<HTMLElement | null>,
  onDismiss: () => void,
): {
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
} {
  const drag = useRef<DragState | null>(null);

  const reset = (el: HTMLElement) => {
    el.style.transition = 'transform var(--dur-slow) var(--ease-standard)';
    el.style.transform = '';
    const clear = () => {
      el.style.transition = '';
      el.removeEventListener('transitionend', clear);
    };
    el.addEventListener('transitionend', clear);
  };

  return {
    onPointerDown: (event) => {
      if (!event.isPrimary || event.button !== 0) return;
      // Buttons in the handle row (‹ back, ⋯) keep their own taps.
      if ((event.target as Element).closest('button,a,[role="button"]')) return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      drag.current = {
        pointerId: event.pointerId,
        startY: event.clientY,
        lastY: event.clientY,
        lastT: event.timeStamp,
        velocity: 0,
      };
    },
    onPointerMove: (event) => {
      const state = drag.current;
      const el = surface.current;
      if (!state || !el || state.pointerId !== event.pointerId) return;
      const dt = Math.max(1, event.timeStamp - state.lastT);
      state.velocity = (event.clientY - state.lastY) / dt;
      state.lastY = event.clientY;
      state.lastT = event.timeStamp;
      const dy = Math.max(0, event.clientY - state.startY);
      el.style.transition = 'none';
      el.style.transform = dy > 0 ? `translateY(${dy}px)` : '';
    },
    onPointerUp: (event) => {
      const state = drag.current;
      const el = surface.current;
      drag.current = null;
      if (!state || !el) return;
      const dy = Math.max(0, event.clientY - state.startY);
      const dismiss =
        dy > el.getBoundingClientRect().height * dismissShare ||
        (dy > 24 && state.velocity > flingVelocity);
      if (dismiss) {
        el.style.transition = 'transform var(--dur-slow) var(--ease-exit)';
        el.style.transform = 'translateY(100%)';
        onDismiss();
      } else reset(el);
    },
    onPointerCancel: () => {
      drag.current = null;
      if (surface.current) reset(surface.current);
    },
  };
}
