import { describe, expect, it } from 'vitest';
import { REMINDER_OFFSET_MAX } from '../src/limits.ts';
import {
  dueMoment,
  formatReminderOffset,
  parseReminderOffset,
  resolveFireAt,
} from '../src/reminders.ts';

const owner = { timezone: 'Europe/Stockholm', allDayReminderTime: '09:00' };

describe('dueMoment (FR-REM-2)', () => {
  it('a timed task: its due date and time in its own zone', () => {
    expect(
      dueMoment({ dueDate: '2026-10-09', dueTime: '14:00', dueTz: 'America/New_York' }, owner),
    ).toBe(Date.UTC(2026, 9, 9, 18));
  });

  it("an all-day task: the owner's default reminder time in the owner's zone", () => {
    const task = { dueDate: '2026-10-09', dueTime: null, dueTz: null };
    expect(dueMoment(task, owner)).toBe(Date.UTC(2026, 9, 9, 7));
    expect(dueMoment(task, { ...owner, allDayReminderTime: '18:30' })).toBe(
      Date.UTC(2026, 9, 9, 16, 30),
    );
    // A malformed preference falls back to 09:00; winter time is UTC+1.
    expect(
      dueMoment({ ...task, dueDate: '2026-12-01' }, { ...owner, allDayReminderTime: '9am' }),
    ).toBe(Date.UTC(2026, 11, 1, 8));
  });

  it('is null without a (valid) due date', () => {
    expect(dueMoment({ dueDate: null, dueTime: null, dueTz: null }, owner)).toBeNull();
    expect(dueMoment({ dueDate: '2026-02-30', dueTime: null, dueTz: null }, owner)).toBeNull();
  });
});

describe('resolveFireAt', () => {
  const task = { dueDate: '2026-10-09', dueTime: '14:00', dueTz: 'UTC' };

  it('absolute reminders fire at their instant, with or without a due date', () => {
    const at = Date.UTC(2026, 9, 8);
    const reminder = { kind: 'absolute' as const, offsetMinutes: null, remindAt: at };
    expect(resolveFireAt(reminder, task, owner)).toBe(at);
    expect(resolveFireAt(reminder, { dueDate: null, dueTime: null, dueTz: null }, owner)).toBe(at);
  });

  it('relative reminders fire that long before the due moment, and are dormant without one', () => {
    const reminder = { kind: 'relative' as const, offsetMinutes: 90, remindAt: null };
    expect(resolveFireAt(reminder, task, owner)).toBe(Date.UTC(2026, 9, 9, 12, 30));
    expect(resolveFireAt({ ...reminder, offsetMinutes: 0 }, task, owner)).toBe(
      Date.UTC(2026, 9, 9, 14),
    );
    expect(
      resolveFireAt(reminder, { dueDate: null, dueTime: null, dueTz: null }, owner),
    ).toBeNull();
    expect(resolveFireAt({ ...reminder, offsetMinutes: null }, task, owner)).toBeNull();
  });
});

describe('reminder offsets (02 §8.1)', () => {
  it.each([
    ['15m', 15],
    ['2h', 120],
    ['1d', 1440],
    ['due', 0],
    ['DUE', 0],
    [' 1H ', 60],
    ['0m', 0],
    ['28d', REMINDER_OFFSET_MAX],
    ['29d', null],
    ['40321m', null],
    ['15', null],
    ['m', null],
    ['1w', null],
    ['', null],
    ['123456m', null],
  ])('parseReminderOffset(%j) → %j', (token, expected) => {
    expect(parseReminderOffset(token)).toBe(expected);
  });

  it.each([
    [0, 'due'],
    [15, '15m'],
    [90, '90m'],
    [120, '2h'],
    [1440, '1d'],
    [2880, '2d'],
    [1500, '25h'],
  ])('formatReminderOffset(%j) → %j', (minutes, token) => {
    expect(formatReminderOffset(minutes)).toBe(token);
    expect(parseReminderOffset(token)).toBe(minutes);
  });
});
