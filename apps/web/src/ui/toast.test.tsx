import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { clearToasts, defaultToastDurationMs, ToastRegion, toast } from './toast';

describe('toasts hide themselves', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    act(() => clearToasts());
    vi.useRealTimers();
  });

  const show = (message: string, extra: Parameters<typeof toast>[0] = { message }) =>
    act(() => {
      toast({ ...extra, message });
    });
  const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));
  const region = () => document.querySelector('[data-toast-region]') as HTMLElement;

  test('after 6 s, but not while hovered', () => {
    render(<ToastRegion />);
    show('Completed “Book dentist”');
    fireEvent.mouseEnter(region());
    wait(defaultToastDurationMs + 1000);
    expect(screen.queryByText('Completed “Book dentist”')).not.toBeNull();
    fireEvent.mouseLeave(region());
    wait(defaultToastDurationMs);
    expect(screen.queryByText('Completed “Book dentist”')).toBeNull();
  });

  test('a toast closed under the pointer (Undo) doesn’t keep the next ones up', () => {
    render(<ToastRegion />);
    show('Completed “A”', { message: '', action: { label: 'Undo', onAction: () => {} } });
    fireEvent.mouseEnter(region());
    // The toast goes away under the pointer: no mouseleave follows, as in a browser.
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    show('Completed “B”');
    wait(defaultToastDurationMs + 100);
    expect(screen.queryByText('Completed “B”')).toBeNull();
  });

  test('a toast closed with focus in it doesn’t keep the next ones up', () => {
    render(<ToastRegion />);
    show('Deleted', { message: '', action: { label: 'Undo', onAction: () => {} } });
    const undo = screen.getByRole('button', { name: 'Undo' });
    act(() => undo.focus());
    fireEvent.click(undo);
    show('Completed “C”');
    wait(defaultToastDurationMs + 100);
    expect(screen.queryByText('Completed “C”')).toBeNull();
  });

  test('a toast without a duration stays until closed', () => {
    render(<ToastRegion />);
    show('A new version is available', { message: '', durationMs: null });
    wait(7 * 24 * 60 * 60 * 1000);
    expect(screen.queryByText('A new version is available')).not.toBeNull();
  });
});
