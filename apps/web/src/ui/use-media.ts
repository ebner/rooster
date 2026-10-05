import { useEffect, useState, useSyncExternalStore } from 'react';

/** 02 §2 breakpoints (03 §2.8): mobile < 768 ≤ tablet < 1200 ≤ desktop. */
export const mobileQuery = '(max-width: 767.98px)';
export const tabletQuery = '(min-width: 768px) and (max-width: 1199.98px)';

export type Breakpoint = 'mobile' | 'tablet' | 'desktop';

function query(media: string): MediaQueryList | null {
  return globalThis.matchMedia?.(media) ?? null;
}

/** Read at event time (no subscription): cheap enough for a row's click handler. */
export function isMobileViewport(): boolean {
  return query(mobileQuery)?.matches ?? false;
}

export function useMediaQuery(media: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = query(media);
      list?.addEventListener('change', onChange);
      return () => list?.removeEventListener('change', onChange);
    },
    () => query(media)?.matches ?? false,
    () => false,
  );
}

export function useBreakpoint(): Breakpoint {
  const mobile = useMediaQuery(mobileQuery);
  const tablet = useMediaQuery(tabletQuery);
  return mobile ? 'mobile' : tablet ? 'tablet' : 'desktop';
}

export function useIsMobile(): boolean {
  return useMediaQuery(mobileQuery);
}

/** `prefers-reduced-motion` (02 §15): gestures snap instead of animating. */
export function useReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}

/**
 * How much of the layout viewport the on-screen keyboard covers, from `visualViewport`
 * (02 §13.3). Zero without a keyboard or where the API is missing.
 */
export function keyboardInset(): number {
  const vv = globalThis.visualViewport;
  if (!vv) return 0;
  return Math.max(0, Math.round(globalThis.innerHeight - vv.height - vv.offsetTop));
}

/** The keyboard inset, kept current while the visual viewport resizes or scrolls. */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(keyboardInset);
  useEffect(() => {
    const vv = globalThis.visualViewport;
    if (!vv) return;
    const update = () => setInset(keyboardInset());
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
  return inset;
}

function editableFocused(): boolean {
  const el = globalThis.document?.activeElement;
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'button', 'submit', 'range', 'color'].includes(el.type);
  }
  return el instanceof HTMLElement && el.isContentEditable;
}

/**
 * Whether the on-screen keyboard is (about to be) open: a text field has focus on a phone.
 * Focus is the reliable signal (the keyboard's own size arrives late, or never in
 * emulators); the FAB and the bottom nav hide while it is true (02 §13.1).
 */
export function useEditingFocus(): boolean {
  const [focused, setFocused] = useState(editableFocused);
  useEffect(() => {
    const update = () => setFocused(editableFocused());
    // On focusout, activeElement is still the old field (or body); read it after the move.
    const later = () => queueMicrotask(update);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', later);
    return () => {
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', later);
    };
  }, []);
  return focused;
}
