import type { SwipeAction } from '@rooster/core/schemas';
import type { SwipeRevealAction } from '../../ui/swipe-reveal';

/** 02 §13.2: a swipe commits past 30 % of the row's width, or with a fling. */
export const swipeCommitShare = 0.3;
/** px/ms, with at least `flingMinPx` of travel. */
export const flingVelocity = 0.6;
export const flingMinPx = 40;
/** Movement that decides between a swipe and a scroll (and stays under a tap's slop). */
export const swipeSlopPx = 10;
/** A swipe toward a direction without an action only stretches this much (rubber band). */
export const swipeResistance = 0.15;
/** A long-press that moved less than this enters selection mode instead of dropping. */
export const longPressSlopPx = 8;

/** The duration of a motion token in ms (0 under reduced motion, 03 §2.7). */
export function motionMs(token: 'fast' | 'base' | 'slow'): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(`--dur-${token}`);
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : 0;
}

let suppressed: { until: number; x: number; y: number; within: Element | null } | null = null;
/** The gesture's own click lands where the finger lifted; taps elsewhere are new taps. */
const ghostClickRadiusPx = 24;

/**
 * After a swipe or a long-press, the browser may still deliver the gesture's click (near where
 * the finger lifted, or on the gesture's row, e.g. a checkbox the swipe started on); it must
 * not open the detail sheet or toggle anything as well. Swallows such a click, briefly.
 */
export function suppressNextClick(
  x: number,
  y: number,
  within: Element | null = null,
  windowMs = 600,
): void {
  suppressed = { until: performance.now() + windowMs, x, y, within };
}

export function clickSuppressed(event: {
  clientX: number;
  clientY: number;
  target?: EventTarget | null;
}): boolean {
  if (!suppressed || performance.now() > suppressed.until) return false;
  const near =
    Math.abs(event.clientX - suppressed.x) <= ghostClickRadiusPx &&
    Math.abs(event.clientY - suppressed.y) <= ghostClickRadiusPx;
  const onRow =
    suppressed.within !== null &&
    event.target instanceof Node &&
    suppressed.within.contains(event.target);
  if (near || onRow) suppressed = null;
  return near || onRow;
}

/** Which action a horizontal offset reveals: right swipes use `swipeRight`, left `swipeLeft`. */
export function swipeActionFor(
  dx: number,
  prefs: { swipeLeft: SwipeAction; swipeRight: SwipeAction },
): SwipeRevealAction | null {
  const action = dx >= 0 ? prefs.swipeRight : prefs.swipeLeft;
  return action === 'none' ? null : action;
}

/** Whether a released swipe commits (02 §13.2: ≥ 30 % of the width, or a fling). */
export function swipeCommits(dx: number, velocity: number, width: number): boolean {
  if (Math.abs(dx) >= width * swipeCommitShare) return true;
  return Math.abs(dx) >= flingMinPx && Math.abs(velocity) >= flingVelocity && dx * velocity > 0;
}
