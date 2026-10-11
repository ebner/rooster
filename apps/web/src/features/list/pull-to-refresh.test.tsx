import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { lastAnnouncement } from './announcer';
import { minRefreshMs, PullToRefresh } from './pull-to-refresh';

function setup(onRefresh: () => Promise<unknown>) {
  render(
    <div data-testid="scroller" style={{ overflowY: 'auto' }}>
      <PullToRefresh enabled onRefresh={onRefresh} />
    </div>,
  );
  return {
    indicator: screen.getByTestId('pull-to-refresh'),
    scroller: screen.getByTestId('scroller'),
  };
}

/** jsdom's TouchEvent needs Touch objects; the listeners only read `touches[0].clientY`. */
function touch(target: Element, type: string, clientY?: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: clientY === undefined ? [] : [{ clientY }] });
  act(() => {
    target.dispatchEvent(event);
  });
}

function pull(scroller: Element, distance: number) {
  touch(scroller, 'touchstart', 100);
  touch(scroller, 'touchmove', 100 + distance);
  touch(scroller, 'touchend');
}

describe('pull to refresh (02 §13.2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test(`a fast refetch still turns the spinner for ${minRefreshMs} ms`, async () => {
    const onRefresh = vi.fn(() => Promise.resolve());
    const { indicator, scroller } = setup(onRefresh);
    pull(scroller, 200);
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(indicator.dataset.state).toBe('refreshing');
    await act(() => vi.advanceTimersByTimeAsync(minRefreshMs - 1));
    expect(indicator.dataset.state).toBe('refreshing');
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(indicator.dataset.state).toBe('idle');
    expect(lastAnnouncement()).toBe('Up to date');
  });

  test('a slow refetch keeps it turning until it settles, even when it fails', async () => {
    let fail: (error: Error) => void = () => undefined;
    const { indicator, scroller } = setup(() => new Promise((_, reject) => (fail = reject)));
    pull(scroller, 200);
    await act(() => vi.advanceTimersByTimeAsync(minRefreshMs * 4));
    expect(indicator.dataset.state).toBe('refreshing');
    await act(async () => fail(new Error('offline')));
    expect(indicator.dataset.state).toBe('idle');
  });

  test('a pull short of the threshold refreshes nothing', () => {
    const onRefresh = vi.fn(() => Promise.resolve());
    const { indicator, scroller } = setup(onRefresh);
    pull(scroller, 60);
    expect(onRefresh).not.toHaveBeenCalled();
    expect(indicator.dataset.state).toBe('idle');
  });
});
