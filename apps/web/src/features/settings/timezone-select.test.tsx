import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { listTimezones, matchesTimezone, TimezoneSelect } from './timezone-select';

describe('timezone matching', () => {
  const zones = listTimezones(Date.UTC(2026, 0, 1));

  test('lists IANA zones plus UTC', () => {
    expect(zones.some((z) => z.id === 'Europe/Stockholm')).toBe(true);
    expect(zones.some((z) => z.id === 'UTC')).toBe(true);
  });

  test('matches words in any order, ignoring "_" and "/"', () => {
    const ny = zones.find((z) => z.id === 'America/New_York');
    expect(ny && matchesTimezone(ny, 'new york')).toBe(true);
    expect(ny && matchesTimezone(ny, 'york america')).toBe(true);
    expect(ny && matchesTimezone(ny, 'stockholm')).toBe(false);
  });
});

describe('TimezoneSelect', () => {
  test('typing filters the options and picking one reports it', () => {
    const onChange = vi.fn();
    render(<TimezoneSelect value="UTC" onChange={onChange} />);
    const input = screen.getByRole('combobox', { name: 'Time zone' });
    act(() => input.focus());
    fireEvent.change(input, { target: { value: 'stockh' } });
    const listbox = screen.getByRole('listbox');
    const options = within(listbox).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining('Europe/Stockholm'),
    ]);
    fireEvent.click(options[0] as HTMLElement);
    expect(onChange).toHaveBeenCalledWith('Europe/Stockholm');
  });
});
