import { dueInstant } from '@rooster/core/dates';
import { fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { DatePanel, type ReminderSlotProps } from './date-popover';
import { sampleDateContext, sampleDue, sampleOwner, sampleReminder, sampleZone } from './fixtures';
import { useRuleText } from './recurrence-text';
import { ReminderSection } from './reminder-section';
import { type DueValue, noDue } from './types';

const en = sampleDateContext('en');
const sv = sampleDateContext('sv');

describe('rule text (describeRule, localised)', () => {
  test('English and Swedish summaries', () => {
    const { result: e } = renderHook(() => useRuleText(en));
    const { result: s } = renderHook(() => useRuleText(sv));
    expect(e.current('FREQ=DAILY')).toBe('Daily');
    expect(e.current('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')).toBe('Every weekday');
    expect(e.current('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH')).toBe(
      'Every 2 weeks on Monday and Thursday',
    );
    expect(e.current('FREQ=MONTHLY;BYMONTHDAY=15')).toBe('Monthly on the 15th');
    expect(e.current('FREQ=MONTHLY;BYDAY=-1FR;COUNT=4')).toBe(
      'Monthly on the last Friday, 4 times',
    );
    expect(e.current('FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=12')).toBe('Yearly on Oct 12');
    expect(e.current('FREQ=DAILY;INTERVAL=3', 'completion')).toBe('3 days after completion');
    expect(s.current('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO')).toBe('Varannan vecka på måndag');
    expect(s.current('FREQ=DAILY;INTERVAL=3')).toBe('Var 3:e dag');
    expect(s.current('FREQ=MONTHLY;BYDAY=-1FR')).toBe('Den sista fredagen varje månad');
    expect(s.current('FREQ=MONTHLY;BYMONTHDAY=15;UNTIL=20261231')).toBe(
      'Den 15:e varje månad, till och med tor 31 dec',
    );
    expect(s.current('FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=12')).toBe('Varje år den 12 okt');
  });
});

function renderPanel(value: DueValue, extra: Partial<Parameters<typeof DatePanel>[0]> = {}) {
  const onCommit = vi.fn<(next: DueValue | null) => void>();
  render(
    <DatePanel
      value={value}
      ctx={en}
      onCommit={onCommit}
      onCancel={() => {}}
      autoFocus={false}
      repeatable
      {...extra}
    />,
  );
  return { onCommit };
}

describe('the picker’s Repeat section (02 §7, FR-REC-1)', () => {
  test('a preset follows the date; Enter commits the rule with it', () => {
    const { onCommit } = renderPanel(sampleDue('2026-10-09'));
    fireEvent.click(screen.getByRole('button', { name: 'Repeat' }));
    const section = screen.getByTestId('repeat-section');
    fireEvent.click(within(section).getByRole('radio', { name: 'Weekly on Friday' }));
    // A day pick commits the date and the repeat together (the preset follows the new date).
    fireEvent.click(screen.getByRole('gridcell', { name: /October 12, 2026/ }));
    expect(onCommit).toHaveBeenCalledWith({
      ...sampleDue('2026-10-12'),
      recurrence: 'FREQ=WEEKLY;BYDAY=MO',
      recurrenceBasis: 'due',
    });
  });

  test('a repeat without a due date also sets the first date', () => {
    const { onCommit } = renderPanel(noDue);
    fireEvent.click(screen.getByRole('button', { name: 'Repeat' }));
    // Thursday Oct 8: "every weekday" starts today.
    fireEvent.click(screen.getByRole('radio', { name: 'Every weekday' }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Type a date' }), { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith({
      ...sampleDue('2026-10-08'),
      recurrence: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
      recurrenceBasis: 'due',
    });
  });

  test('custom: weekdays, interval, the basis and an end; stop repeating clears it', () => {
    const { onCommit } = renderPanel({
      ...sampleDue('2026-10-12'),
      recurrence: 'FREQ=WEEKLY;BYDAY=MO',
      recurrenceBasis: 'due',
    });
    const section = screen.getByTestId('repeat-section');
    fireEvent.click(within(section).getByRole('radio', { name: 'Custom…' }));
    const custom = screen.getByTestId('repeat-custom');
    fireEvent.click(within(custom).getByRole('button', { name: 'Thursday' }));
    expect(screen.getByTestId('repeat-summary').textContent).toBe('Weekly on Monday and Thursday');
    fireEvent.click(within(custom).getByRole('switch', { name: 'Count from completion' }));
    expect(screen.getByTestId('repeat-summary').textContent).toBe('1 week after completion');
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Type a date' }), { key: 'Enter' });
    expect(onCommit).toHaveBeenLastCalledWith({
      ...sampleDue('2026-10-12'),
      recurrence: 'FREQ=WEEKLY',
      recurrenceBasis: 'completion',
    });
    fireEvent.click(within(section).getByRole('button', { name: 'Stop repeating' }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Type a date' }), { key: 'Enter' });
    expect(onCommit).toHaveBeenLastCalledWith({
      ...sampleDue('2026-10-12'),
      recurrence: null,
      recurrenceBasis: null,
    });
  });

  test('custom: changing the end keeps the stored anchor of a clamped occurrence', () => {
    // A series on the 31st whose February occurrence was clamped to the 28th.
    const { onCommit } = renderPanel({
      ...sampleDue('2027-02-28'),
      recurrence: 'FREQ=MONTHLY;BYMONTHDAY=31;COUNT=3',
      recurrenceBasis: 'due',
    });
    const custom = screen.getByTestId('repeat-custom');
    expect(within(custom).getByRole('radio', { name: 'On the 31st' })).toBeTruthy();
    const count = within(custom).getByRole('textbox', { name: 'Times' });
    fireEvent.change(count, { target: { value: '4' } });
    fireEvent.blur(count);
    expect(screen.getByTestId('repeat-summary').textContent).toBe('Monthly on the 31st, 4 times');
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Type a date' }), { key: 'Enter' });
    expect(onCommit).toHaveBeenLastCalledWith({
      ...sampleDue('2027-02-28'),
      recurrence: 'FREQ=MONTHLY;BYMONTHDAY=31;COUNT=4',
      recurrenceBasis: 'due',
    });
  });

  test('custom: "Ends → On a date" shows the date field until a date is typed', () => {
    const { onCommit } = renderPanel({
      ...sampleDue('2026-10-12'),
      recurrence: 'FREQ=WEEKLY;BYDAY=MO,TH',
      recurrenceBasis: 'due',
    });
    const custom = screen.getByTestId('repeat-custom');
    fireEvent.click(within(custom).getByRole('button', { name: /Ends$/ }));
    fireEvent.click(screen.getByRole('option', { name: 'On a date' }));
    expect(within(custom).getByRole('button', { name: /Ends$/ }).textContent).toContain(
      'On a date',
    );
    const until = within(custom).getByRole('textbox', { name: 'Last date' });
    fireEvent.change(until, { target: { value: '2026-12-31' } });
    expect(screen.getByTestId('repeat-summary').textContent).toMatch(
      /^Weekly on Monday and Thursday, until /,
    );
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Type a date' }), { key: 'Enter' });
    expect(onCommit).toHaveBeenLastCalledWith({
      ...sampleDue('2026-10-12'),
      recurrence: 'FREQ=WEEKLY;BYDAY=MO,TH;UNTIL=20261231',
      recurrenceBasis: 'due',
    });
  });
});

describe('the picker’s Reminder section (02 §7, FR-REM)', () => {
  const timed = sampleDue('2026-10-09', '14:00');

  function Slot(props: ReminderSlotProps & { onAdd: (spec: unknown) => void }) {
    const [items] = useState([sampleReminder(1, { offsetMinutes: 60 }, timed)]);
    return (
      <ReminderSection
        items={items}
        due={props.due}
        owner={sampleOwner}
        ctx={en}
        onAdd={(spec) => {
          props.applyDraft();
          props.onAdd(spec);
        }}
        onRemove={() => {}}
        autoFocus={props.autoFocus}
      />
    );
  }

  test('Alt+R opens it; chips, presets and a custom offset; the picker stays open', () => {
    const onAdd = vi.fn();
    const { onCommit } = renderPanel(timed, {
      renderReminders: (slot) => <Slot {...slot} onAdd={onAdd} />,
    });
    expect(screen.queryByTestId('reminder-section')).toBeNull();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Type a date' }), {
      key: 'r',
      code: 'KeyR',
      altKey: true,
    });
    const section = screen.getByTestId('reminder-section');
    expect(within(section).getByTestId('reminder-chip').textContent).toContain(
      '1 h before · Tomorrow 1 PM',
    );
    // The existing offset is not offered again.
    expect(
      (within(section).getByRole('button', { name: '1 hour before' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(within(section).getByRole('button', { name: '15 min before' }));
    expect(onAdd).toHaveBeenLastCalledWith({ offsetMinutes: 15 });
    fireEvent.click(within(section).getByRole('button', { name: 'Custom…' }));
    const custom = within(section).getByRole('textbox', { name: 'Custom reminder' });
    fireEvent.change(custom, { target: { value: '2h' } });
    expect(screen.getByTestId('reminder-custom-status').textContent).toBe(
      '→ 2 h before · Tomorrow 12 PM',
    );
    fireEvent.keyDown(custom, { key: 'Enter' });
    expect(onAdd).toHaveBeenLastCalledWith({ offsetMinutes: 120 });
    fireEvent.change(custom, { target: { value: 'fri 9:30' } });
    fireEvent.keyDown(custom, { key: 'Enter' });
    expect(onAdd).toHaveBeenLastCalledWith({ at: dueInstant('2026-10-09', '09:30', sampleZone) });
    // Adding never committed (closed) the picker.
    expect(onCommit).not.toHaveBeenCalled();
  });

  test('without a due date only absolute reminders; dormant chips say why', () => {
    render(
      <ReminderSection
        items={[sampleReminder(2, { offsetMinutes: 30 }, null)]}
        due={noDue}
        owner={sampleOwner}
        ctx={en}
        onAdd={() => {}}
        onRemove={() => {}}
      />,
    );
    expect(screen.getByTestId('reminder-chip').textContent).toContain(
      '30 min before · needs a due date',
    );
    expect(screen.queryByRole('button', { name: '15 min before' })).toBeNull();
    const input = screen.getByRole('textbox', { name: 'Custom reminder' });
    fireEvent.change(input, { target: { value: '1h' } });
    expect(screen.getByTestId('reminder-custom-status').textContent).toBe(
      'That needs a due date. Pick a date and time instead.',
    );
    fireEvent.change(input, { target: { value: 'yesterday 9:00' } });
    expect(screen.getByTestId('reminder-custom-status').textContent).not.toBe('');
  });

  test('an all-day task offers "On the day at" the default reminder time', () => {
    render(
      <ReminderSection
        items={[]}
        due={sampleDue('2026-10-12')}
        owner={sampleOwner}
        ctx={sv}
        onAdd={() => {}}
        onRemove={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Samma dag kl. 09:00' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '1 dag före' })).toBeTruthy();
  });
});
