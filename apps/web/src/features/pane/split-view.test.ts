import { afterEach, describe, expect, test, vi } from 'vitest';
import { uiScale } from '../../lib/ui-scale';
import {
  clampPaneWidth,
  effectivePaneWidth,
  listWidthMin,
  paneWidthDefault,
} from '../../state/pane-store';
import { paneMode } from './split-view';

describe('paneMode (02 §2, D-29/D-29a)', () => {
  const desktop = { viewport: 1440, container: 1192, paneWidth: 520, fullScreen: false };

  test('phones get the sheet, tablets the overlay, full screen wins above phones', () => {
    expect(paneMode({ ...desktop, viewport: 767 })).toBe('sheet');
    expect(paneMode({ ...desktop, viewport: 767, fullScreen: true })).toBe('sheet');
    expect(paneMode({ ...desktop, viewport: 1024 })).toBe('overlay');
    expect(paneMode({ ...desktop, fullScreen: true })).toBe('full');
  });

  test('splits while the list keeps its minimum, overlays below it (scale 1)', () => {
    expect(paneMode(desktop)).toBe('split');
    expect(paneMode({ ...desktop, container: 520 + listWidthMin })).toBe('split');
    expect(paneMode({ ...desktop, container: 520 + listWidthMin - 1 })).toBe('overlay');
  });

  test('the list minimum follows the UI scale', () => {
    // 1440 px window at 112.5 %: sidebar 279 px, pane 585 px, list minimum 540 px.
    const scaled = { ...desktop, container: 1161, paneWidth: 585, listMin: listWidthMin * 1.125 };
    expect(paneMode(scaled)).toBe('split');
    expect(paneMode({ ...scaled, listMin: listWidthMin * 1.25 })).toBe('overlay');
  });
});

describe('pane width at a UI scale', () => {
  test('the default width scales with the root font size', () => {
    expect(effectivePaneWidth(null, 1)).toBe(paneWidthDefault);
    expect(effectivePaneWidth(null, 1.125)).toBe(585);
    expect(effectivePaneWidth(null, 1.25)).toBe(650);
  });

  test('a resized width stays as set, clamped to the scaled 400–720 range', () => {
    expect(effectivePaneWidth(600, 1)).toBe(600);
    expect(effectivePaneWidth(600, 1.25)).toBe(600);
    expect(effectivePaneWidth(420, 1.25)).toBe(500);
    expect(effectivePaneWidth(880, 1.125)).toBe(810);
    expect(clampPaneWidth(380)).toBe(400);
    expect(clampPaneWidth(900, 1.25)).toBe(900);
    expect(clampPaneWidth(901, 1.25)).toBe(900);
  });
});

describe('uiScale', () => {
  afterEach(() => {
    document.documentElement.style.fontSize = '';
    vi.restoreAllMocks();
  });

  test('is the root font size over 16 px', () => {
    document.documentElement.style.fontSize = '18px';
    expect(uiScale()).toBe(1.125);
    document.documentElement.style.fontSize = '20px';
    expect(uiScale()).toBe(1.25);
  });

  test('falls back to 1 when the root font size cannot be read', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      fontSize: '',
    } as CSSStyleDeclaration);
    expect(uiScale()).toBe(1);
  });
});
