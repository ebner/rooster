import { describe, expect, it } from 'vitest';
import {
  addDays,
  daysInMonth,
  diffDays,
  formatIsoDate,
  isValidIsoDate,
  isValidTime,
  nextWeekday,
  parseIsoDate,
  parseTime,
  startOfWeek,
  todayIn,
  weekdayOf,
} from '../src/dates.ts';

describe('isValidIsoDate', () => {
  it.each([
    ['2026-10-04', true],
    ['2024-02-29', true],
    ['2000-02-29', true],
    ['1900-02-29', false],
    ['2026-02-29', false],
    ['2026-04-31', false],
    ['2026-13-01', false],
    ['2026-00-10', false],
    ['2026-10-00', false],
    ['2026-1-04', false],
    ['2026-10-04T00:00', false],
    ['', false],
    [20261004, false],
  ])('%s → %s', (value, expected) => {
    expect(isValidIsoDate(value)).toBe(expected);
  });
});

describe('time helpers', () => {
  it.each([
    ['00:00', true],
    ['23:59', true],
    ['24:00', false],
    ['12:60', false],
    ['9:00', false],
    [900, false],
  ])('isValidTime(%s) → %s', (value, expected) => {
    expect(isValidTime(value)).toBe(expected);
  });

  it('parseTime', () => {
    expect(parseTime('14:30')).toEqual({ hour: 14, minute: 30 });
    expect(() => parseTime('25:00')).toThrow(RangeError);
  });
});

describe('calendar arithmetic', () => {
  it('parse/format round trip and invalid input', () => {
    expect(parseIsoDate('2026-10-04')).toEqual({ year: 2026, month: 10, day: 4 });
    expect(formatIsoDate({ year: 26, month: 1, day: 2 })).toBe('0026-01-02');
    expect(() => parseIsoDate('2026-02-30')).toThrow(RangeError);
    expect(() => addDays('nope', 1)).toThrow(RangeError);
  });

  it('daysInMonth', () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });

  it.each([
    ['2026-10-04', 1, '2026-10-05'],
    ['2026-10-31', 1, '2026-11-01'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2024-02-28', 1, '2024-02-29'],
    ['2026-03-01', -1, '2026-02-28'],
    ['2026-03-28', 2, '2026-03-30'],
    ['2026-10-24', 2, '2026-10-26'],
    ['2026-10-04', 365, '2027-10-04'],
    ['1970-01-01', -1, '1969-12-31'],
    ['2000-03-01', -1, '2000-02-29'],
    ['2026-10-04', 0, '2026-10-04'],
  ])('addDays(%s, %i) = %s', (date, n, expected) => {
    expect(addDays(date, n)).toBe(expected);
  });

  it('addDays agrees with UTC Date arithmetic over a long span', () => {
    const base = Date.UTC(1999, 0, 1);
    for (let i = 0; i < 20_000; i += 7) {
      const expected = new Date(base + i * 86_400_000).toISOString().slice(0, 10);
      expect(addDays('1999-01-01', i)).toBe(expected);
      expect(diffDays(expected, '1999-01-01')).toBe(i);
    }
  });

  it('diffDays is a - b', () => {
    expect(diffDays('2026-10-12', '2026-10-10')).toBe(2);
    expect(diffDays('2026-10-10', '2026-10-12')).toBe(-2);
    expect(diffDays('2027-01-01', '2026-01-01')).toBe(365);
    expect(diffDays('2026-03-30', '2026-03-29')).toBe(1);
  });

  it.each([
    ['1970-01-01', 4],
    ['2026-10-04', 0],
    ['2026-10-05', 1],
    ['2026-10-10', 6],
    ['1969-12-31', 3],
    ['2000-02-29', 2],
  ])('weekdayOf(%s) = %i', (date, expected) => {
    expect(weekdayOf(date)).toBe(expected);
  });

  it('startOfWeek honours the week start setting', () => {
    expect(startOfWeek('2026-10-07', 1)).toBe('2026-10-05');
    expect(startOfWeek('2026-10-07', 0)).toBe('2026-10-04');
    expect(startOfWeek('2026-10-04', 1)).toBe('2026-09-28');
    expect(startOfWeek('2026-10-04', 0)).toBe('2026-10-04');
    expect(startOfWeek('2026-10-05', 1)).toBe('2026-10-05');
  });

  it('nextWeekday is strictly after today unless includeToday', () => {
    // 2026-10-05 is a Monday.
    expect(nextWeekday('2026-10-05', 1)).toBe('2026-10-12');
    expect(nextWeekday('2026-10-05', 1, { includeToday: false })).toBe('2026-10-12');
    expect(nextWeekday('2026-10-05', 1, { includeToday: true })).toBe('2026-10-05');
    expect(nextWeekday('2026-10-05', 5)).toBe('2026-10-09');
    expect(nextWeekday('2026-10-05', 0)).toBe('2026-10-11');
    expect(nextWeekday('2026-12-31', 5, { includeToday: true })).toBe('2027-01-01');
  });
});

describe('todayIn', () => {
  it('uses the viewer timezone', () => {
    const now = Date.UTC(2026, 9, 4, 23, 30);
    expect(todayIn('UTC', now)).toBe('2026-10-04');
    expect(todayIn('Europe/Stockholm', now)).toBe('2026-10-05');
    expect(todayIn('America/Los_Angeles', now)).toBe('2026-10-04');
    expect(todayIn('Pacific/Kiritimati', Date.UTC(2026, 9, 4, 10, 0))).toBe('2026-10-05');
  });

  it('DST start in Europe/Stockholm (last Sunday of March)', () => {
    // 2026-03-29: CET (+1) until 01:00Z, CEST (+2) after.
    expect(todayIn('Europe/Stockholm', Date.UTC(2026, 2, 28, 22, 59))).toBe('2026-03-28');
    expect(todayIn('Europe/Stockholm', Date.UTC(2026, 2, 28, 23, 0))).toBe('2026-03-29');
    expect(todayIn('Europe/Stockholm', Date.UTC(2026, 2, 29, 21, 59))).toBe('2026-03-29');
    expect(todayIn('Europe/Stockholm', Date.UTC(2026, 2, 29, 22, 0))).toBe('2026-03-30');
  });

  it('DST end in Europe/Stockholm (last Sunday of October)', () => {
    // 2026-10-25: CEST (+2) until 01:00Z, CET (+1) after.
    expect(todayIn('Europe/Stockholm', Date.UTC(2026, 9, 24, 21, 59))).toBe('2026-10-24');
    expect(todayIn('Europe/Stockholm', Date.UTC(2026, 9, 24, 22, 0))).toBe('2026-10-25');
    expect(todayIn('Europe/Stockholm', Date.UTC(2026, 9, 25, 22, 59))).toBe('2026-10-25');
    expect(todayIn('Europe/Stockholm', Date.UTC(2026, 9, 25, 23, 0))).toBe('2026-10-26');
  });

  it('rejects unknown zones', () => {
    expect(() => todayIn('Nowhere/Atlantis', 0)).toThrow(RangeError);
  });
});
