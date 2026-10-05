import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { DateCell } from './date-cell';
import { DateLabel, useDateLabel } from './date-label';
import { DatePanel } from './date-popover';
import { sampleDateContext, sampleDue, sampleToday, sampleZone } from './fixtures';
import { type DueValue, noDue, type ViewerDateContext } from './types';

const en = sampleDateContext('en');

function renderCell(initial: DueValue = noDue, ctx: ViewerDateContext = en) {
  const onChange = vi.fn<(next: DueValue | null) => void>();
  function Harness() {
    const [value, setValue] = useState(initial);
    return (
      <DateCell
        value={value}
        ctx={ctx}
        onChange={(next) => {
          onChange(next);
          setValue(next ?? noDue);
        }}
      />
    );
  }
  render(<Harness />);
  const cell = screen.getByRole('button', { name: /due date/i });
  return { cell, onChange };
}

function openPicker(cell: HTMLElement) {
  fireEvent.click(cell);
  const dialog = screen.getByRole('dialog', { name: 'Due date' });
  const input = within(dialog).getByRole('textbox', { name: 'Type a date' });
  return { dialog, input };
}

function type(input: HTMLElement, text: string) {
  fireEvent.change(input, { target: { value: text } });
}

describe('DateCell', () => {
  test('a quick chip commits and closes the picker', () => {
    const { cell, onChange } = renderCell();
    const { dialog } = openPicker(cell);
    expect(document.activeElement).toBe(within(dialog).getByRole('textbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: /^Tomorrow/ }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(sampleDue('2026-10-09'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(cell.textContent).toBe('Tomorrow');
  });

  test('Alt+T (matched by event.code) sets today', () => {
    const { cell, onChange } = renderCell(sampleDue('2026-10-20'));
    const { input } = openPicker(cell);
    // On macOS ⌥T produces "†"; the chord must still match.
    fireEvent.keyDown(input, { key: '†', code: 'KeyT', altKey: true });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(sampleDue(sampleToday));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('plain letters go to the input, not the chips', () => {
    const { cell, onChange } = renderCell();
    const { input } = openPicker(cell);
    fireEvent.keyDown(input, { key: 't', code: 'KeyT' });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  test('Alt+0 clears the date', () => {
    const { cell, onChange } = renderCell(sampleDue('2026-10-20'));
    const { input } = openPicker(cell);
    fireEvent.keyDown(input, { key: 'º', code: 'Digit0', altKey: true });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(null);
  });

  test('typing "fri" previews and Enter commits next Friday', () => {
    const { cell, onChange } = renderCell();
    const { dialog, input } = openPicker(cell);
    type(input, 'fri');
    expect(within(dialog).getByText('→ Fri, Oct 9')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(sampleDue('2026-10-09'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('an unparseable phrase says so and Enter does nothing', () => {
    const { cell, onChange } = renderCell();
    const { dialog, input } = openPicker(cell);
    type(input, 'blorp');
    expect(within(dialog).getByText("Can't understand that")).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  test.each([
    ['MMM d', '2026-12-10'],
    ['d MMM', '2026-10-12'],
  ] as const)('numeric "12/10" honours the %s date format', (dateFormat, expected) => {
    const { cell, onChange } = renderCell(noDue, sampleDateContext('en', { dateFormat }));
    const { input } = openPicker(cell);
    type(input, '12/10');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(sampleDue(expected));
  });

  test('Esc closes without changes', () => {
    const { cell, onChange } = renderCell(sampleDue('2026-10-20'));
    const { input } = openPicker(cell);
    type(input, 'fri');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  test('the Time sub-mode keeps the picker open until Enter', () => {
    const { cell, onChange } = renderCell(sampleDue('2026-10-12'));
    const { dialog } = openPicker(cell);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Time' }));
    const time = within(dialog).getByRole('combobox', { name: 'Time' });
    type(time, '14:30');
    // The open suggestion list hides the rest from assistive tech, so find the day directly.
    const day = dialog.querySelector<HTMLElement>('[data-date="2026-10-15"]');
    if (!day) throw new Error('day cell missing');
    fireEvent.click(day);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { hidden: true })).toBeTruthy();
    expect(day.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(time, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledExactlyOnceWith({
      dueDate: '2026-10-15',
      dueTime: '14:30',
      dueTz: sampleZone,
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('in the Time sub-mode, Esc closes the suggestions first, then the picker without changes', () => {
    const { cell, onChange } = renderCell(sampleDue('2026-10-12'));
    const { dialog } = openPicker(cell);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Time' }));
    const time = within(dialog).getByRole('combobox', { name: 'Time' });
    type(time, '14');
    expect(time.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(time, { key: 'Escape' });
    expect(screen.getByRole('dialog', { hidden: true })).toBeTruthy();
    expect(time.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(time, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { hidden: true })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  test('a phrase with a time sets the time and the viewer zone', () => {
    const { cell, onChange } = renderCell();
    const { input } = openPicker(cell);
    type(input, 'tomorrow at 14');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledExactlyOnceWith({
      dueDate: '2026-10-09',
      dueTime: '14:00',
      dueTz: sampleZone,
    });
  });

  test('Delete/Backspace on the focused cell clears the date and stays in the cell', () => {
    const onRowKey = vi.fn();
    const onChange = vi.fn();
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: stands in for the row's keymap
      <div onKeyDown={onRowKey}>
        <DateCell value={sampleDue('2026-10-12')} ctx={en} onChange={onChange} />
      </div>,
    );
    const cell = screen.getByRole('button', { name: /due date/i });
    act(() => cell.focus());
    fireEvent.keyDown(cell, { key: 'Delete' });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(null);
    fireEvent.keyDown(cell, { key: 'Backspace' });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onRowKey).not.toHaveBeenCalled();
    // Other keys still reach the row.
    fireEvent.keyDown(cell, { key: 'j' });
    expect(onRowKey).toHaveBeenCalledTimes(1);
  });

  test('D on the focused cell opens the picker', () => {
    const { cell } = renderCell();
    fireEvent.keyDown(cell, { key: 'd' });
    expect(screen.getByRole('dialog', { name: 'Due date' })).toBeTruthy();
  });

  test('read-only shows the label without a button', () => {
    render(<DateCell value={sampleDue('2026-10-09')} ctx={en} onChange={vi.fn()} isReadOnly />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('img', { name: 'Tomorrow' })).toBeTruthy();
  });
});

function renderPanel(ctx: ViewerDateContext, value: DueValue = noDue) {
  const onCommit = vi.fn();
  render(<DatePanel value={value} ctx={ctx} onCommit={onCommit} onCancel={vi.fn()} />);
  return { onCommit, grid: screen.getByRole('grid') };
}

function rowsOf(grid: HTMLElement): string[][] {
  return within(grid)
    .getAllByRole('row')
    .slice(1)
    .map((row) => [...row.querySelectorAll('td')].map((td) => td.textContent ?? ''));
}

describe('Calendar grid', () => {
  test('arrow keys move the focused day, across months, and Enter commits it', () => {
    const { onCommit, grid } = renderPanel(en, sampleDue('2026-10-30'));
    const start = within(grid).getByRole('gridcell', { name: /October 30, 2026/ });
    expect(start.tabIndex).toBe(0);
    act(() => start.focus());

    fireEvent.keyDown(start, { key: 'ArrowRight' });
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowRight' });
    expect(screen.getByRole('heading', { name: 'November 2026' })).toBeTruthy();
    expect(document.activeElement?.getAttribute('data-date')).toBe('2026-11-01');

    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowUp' });
    expect(document.activeElement?.getAttribute('data-date')).toBe('2026-10-25');
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowLeft' });
    expect(document.activeElement?.getAttribute('data-date')).toBe('2026-10-31');

    fireEvent.keyDown(document.activeElement as Element, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(sampleDue('2026-10-31'));
  });

  test('month buttons change the month shown', () => {
    renderPanel(en);
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(screen.getByRole('heading', { name: 'November 2026' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(screen.getByRole('heading', { name: 'September 2026' })).toBeTruthy();
  });

  test('today is marked and the week starts per setting (Monday)', () => {
    const { grid } = renderPanel(en);
    const headers = within(grid)
      .getAllByRole('columnheader')
      .map((th) => th.textContent);
    expect(headers).toEqual(['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']);
    // 1 October 2026 is a Thursday.
    expect(rowsOf(grid)[0]).toEqual(['', '', '', '1', '2', '3', '4']);
    expect(
      within(grid)
        .getByRole('gridcell', { name: /October 8, 2026/ })
        .getAttribute('aria-current'),
    ).toBe('date');
  });

  test('week start Sunday lays out the month from Sunday', () => {
    const { grid } = renderPanel(sampleDateContext('en', { weekStart: 0 }));
    const headers = within(grid)
      .getAllByRole('columnheader')
      .map((th) => th.textContent);
    expect(headers).toEqual(['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']);
    expect(rowsOf(grid)[0]).toEqual(['', '', '', '', '1', '2', '3']);
    expect(rowsOf(grid).at(-1)).toEqual(['25', '26', '27', '28', '29', '30', '31']);
  });

  test('Swedish picker parses Swedish phrases and labels the month in Swedish', () => {
    const sv = sampleDateContext('sv');
    const { onCommit } = renderPanel(sv);
    expect(screen.getByRole('heading', { name: 'oktober 2026' })).toBeTruthy();
    const input = screen.getByRole('textbox', { name: 'Skriv ett datum' });
    type(input, 'imorgon');
    expect(screen.getByText('→ fre 9 okt')).toBeTruthy();
    type(input, '12/10');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(sampleDue('2026-10-12'));
  });
});

describe('DateLabel', () => {
  function Probe({ value, completed }: { value: DueValue; completed?: boolean }) {
    const info = useDateLabel(value, en, { completed });
    return <output>{info ? `${info.state}|${info.label}|${info.full}` : 'none'}</output>;
  }

  test.each([
    [sampleDue('2026-10-03'), false, 'overdue|Oct 3|Saturday, October 3, 2026'],
    [sampleDue(sampleToday, '09:00'), false, 'overdue|Today 9 AM|Thursday, October 8, 2026, 9 AM'],
    [sampleDue(sampleToday, '14:00'), false, 'today|Today 2 PM|Thursday, October 8, 2026, 2 PM'],
    [sampleDue('2026-10-09'), false, 'tomorrow|Tomorrow|Friday, October 9, 2026'],
    [sampleDue('2026-10-12'), false, 'thisWeek|Mon|Monday, October 12, 2026'],
    [sampleDue('2026-10-24'), false, 'later|Oct 24|Saturday, October 24, 2026'],
    [sampleDue('2026-10-03'), true, 'done|Oct 3|Saturday, October 3, 2026'],
    [noDue, false, 'none'],
  ])('%o (completed: %s) → %s', (value, completed, expected) => {
    render(<Probe value={value} completed={completed} />);
    expect(screen.getByRole('status').textContent).toBe(expected);
  });

  test('a time set in another zone is shown in the viewer zone', () => {
    render(
      <Probe value={{ dueDate: '2026-10-08', dueTime: '23:30', dueTz: 'America/New_York' }} />,
    );
    // 23:30 in New York is 05:30 the next morning in Stockholm.
    expect(screen.getByRole('status').textContent).toBe(
      'tomorrow|Tomorrow 5:30 AM|Friday, October 9, 2026, 5:30 AM',
    );
  });

  test('overdue renders the alert icon, weight 500 and a spoken prefix', () => {
    const { container } = render(<DateLabel value={sampleDue('2026-10-03')} ctx={en} />);
    const label = screen.getByRole('img', { name: 'Overdue: Oct 3' });
    expect(label.className).toContain('text-date-overdue');
    expect(label.className).toContain('font-medium');
    expect(container.querySelector('svg.lucide-circle-alert')).not.toBeNull();
  });
});
