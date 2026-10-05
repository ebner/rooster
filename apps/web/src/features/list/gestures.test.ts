import { describe, expect, it } from 'vitest';
import {
  clickSuppressed,
  flingMinPx,
  suppressNextClick,
  swipeActionFor,
  swipeCommits,
} from './gestures';

describe('swipe gestures (02 §13.2)', () => {
  const prefs = { swipeLeft: 'date', swipeRight: 'complete' } as const;

  it('maps right swipes to swipeRight and left swipes to swipeLeft', () => {
    expect(swipeActionFor(40, prefs)).toBe('complete');
    expect(swipeActionFor(-40, prefs)).toBe('date');
    expect(swipeActionFor(-40, { ...prefs, swipeLeft: 'none' })).toBeNull();
  });

  it('commits past 30 % of the width', () => {
    expect(swipeCommits(117, 0, 390)).toBe(true);
    expect(swipeCommits(-117, 0, 390)).toBe(true);
    expect(swipeCommits(100, 0, 390)).toBe(false);
  });

  it('commits a fling in the direction of travel only', () => {
    expect(swipeCommits(flingMinPx, 0.8, 390)).toBe(true);
    expect(swipeCommits(flingMinPx - 1, 0.8, 390)).toBe(false);
    expect(swipeCommits(flingMinPx, -0.8, 390)).toBe(false);
  });

  it('swallows only the ghost click where the gesture ended', () => {
    suppressNextClick(100, 200);
    expect(clickSuppressed({ clientX: 300, clientY: 500 })).toBe(false);
    expect(clickSuppressed({ clientX: 110, clientY: 205 })).toBe(true);
    // Once.
    expect(clickSuppressed({ clientX: 110, clientY: 205 })).toBe(false);
  });
});
