import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import type { DateSection } from './date-popover';
import { sampleDateContext, sampleDue } from './fixtures';
import { LazyDatePanel } from './lazy';
import { QuickDateSheet } from './quick-date-sheet';
import type { DueValue } from './types';

const en = sampleDateContext('en');
const due: DueValue = { ...sampleDue('2026-10-12'), recurrence: null, recurrenceBasis: null };

beforeAll(async () => {
  await LazyDatePanel.preload();
});

/** The phone pane's use: mounted while closed, opened by a row with or without a section. */
function Harness({ onCommit }: { onCommit: (next: DueValue | null) => void }) {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<DateSection | null>(null);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>
      <button type="button" onClick={() => setSection('repeat')}>
        open repeat
      </button>
      <QuickDateSheet
        isOpen={open || section !== null}
        onOpenChange={(next) => {
          if (next) return;
          setOpen(false);
          setSection(null);
        }}
        value={due}
        ctx={en}
        onCommit={onCommit}
        repeatable
        initialSection={section ?? undefined}
      />
    </>
  );
}

function setup() {
  const onCommit = vi.fn<(next: DueValue | null) => void>();
  render(<Harness onCommit={onCommit} />);
  return { onCommit };
}

function tapScrim() {
  act(() => {
    fireEvent.pointerDown(document.body);
    fireEvent.pointerUp(document.body);
    fireEvent.click(document.body);
  });
}

describe('QuickDateSheet (02 §13.2)', () => {
  test('the pane’s Repeat row opens the sheet on the repeat section, every time', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'open repeat' }));
    expect(screen.getByTestId('repeat-section')).toBeTruthy();
    expect(screen.queryByTestId('quick-date-sheet')).toBeNull();
    fireEvent.keyDown(screen.getByTestId('bottom-sheet'), { key: 'Escape' });
    expect(screen.queryByTestId('bottom-sheet')).toBeNull();
    // A plain opening shows the menu; the section one shows the section again.
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    expect(screen.getByTestId('quick-date-sheet')).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId('bottom-sheet'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'open repeat' }));
    expect(screen.getByTestId('repeat-section')).toBeTruthy();
  });

  test('a repeat chosen in the sheet is saved by a tap on the scrim', () => {
    const { onCommit } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    fireEvent.click(screen.getByRole('button', { name: /^Repeat/ }));
    const section = screen.getByTestId('repeat-section');
    fireEvent.click(within(section).getByRole('radio', { name: 'Daily' }));
    tapScrim();
    expect(onCommit).toHaveBeenCalledExactlyOnceWith({
      ...due,
      recurrence: 'FREQ=DAILY',
      recurrenceBasis: 'due',
    });
    expect(screen.queryByTestId('bottom-sheet')).toBeNull();
  });

  test('"Stop repeating" is saved by a tap on the scrim; Esc discards a draft', () => {
    const onCommit = vi.fn<(next: DueValue | null) => void>();
    function Repeating() {
      const [open, setOpen] = useState(true);
      return (
        <QuickDateSheet
          isOpen={open}
          onOpenChange={setOpen}
          value={{ ...due, recurrence: 'FREQ=DAILY', recurrenceBasis: 'due' }}
          ctx={en}
          onCommit={onCommit}
          repeatable
          initialSection="repeat"
        />
      );
    }
    const { unmount } = render(<Repeating />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop repeating' }));
    tapScrim();
    expect(onCommit).toHaveBeenCalledExactlyOnceWith({
      ...due,
      recurrence: null,
      recurrenceBasis: null,
    });
    unmount();

    onCommit.mockClear();
    render(<Repeating />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop repeating' }));
    fireEvent.keyDown(screen.getByTestId('bottom-sheet'), { key: 'Escape' });
    expect(screen.queryByTestId('bottom-sheet')).toBeNull();
    expect(onCommit).not.toHaveBeenCalled();
  });
});
