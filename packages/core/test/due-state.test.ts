import { describe, expect, it } from 'vitest';
import { type DueInput, dueInstant, dueState, todayIn } from '../src/dates.ts';

const viewerTz = 'Europe/Stockholm';
// 2026-10-05 (Monday) 10:00 in Stockholm (CEST, UTC+2).
const nowMs = Date.UTC(2026, 9, 5, 8, 0);
const ctx = { today: todayIn(viewerTz, nowMs), nowMs, viewerTz };

const task = (dueDate: string | null, extra: Partial<DueInput> = {}): DueInput => ({
  dueDate,
  completed: false,
  ...extra,
});

describe('dueState (03 §2.3)', () => {
  it.each([
    [null, 'none'],
    ['2026-10-04', 'overdue'],
    ['2025-12-31', 'overdue'],
    ['2026-10-05', 'today'],
    ['2026-10-06', 'tomorrow'],
    ['2026-10-07', 'thisWeek'],
    ['2026-10-11', 'thisWeek'],
    ['2026-10-12', 'later'],
    ['2027-01-01', 'later'],
  ] as const)('%s → %s', (dueDate, expected) => {
    expect(dueState(task(dueDate), ctx)).toBe(expected);
  });

  it('completed tasks are done regardless of date', () => {
    expect(dueState(task('2026-10-01', { completed: true }), ctx)).toBe('done');
    expect(dueState(task(null, { completed: true }), ctx)).toBe('done');
  });

  it('a timed due today is overdue once the time has passed', () => {
    const dueTz = 'Europe/Stockholm';
    expect(dueState(task('2026-10-05', { dueTime: '09:59', dueTz }), ctx)).toBe('overdue');
    expect(dueState(task('2026-10-05', { dueTime: '10:00', dueTz }), ctx)).toBe('today');
    expect(dueState(task('2026-10-05', { dueTime: '10:01', dueTz }), ctx)).toBe('today');
    expect(dueState(task('2026-10-05', { dueTime: '23:59', dueTz }), ctx)).toBe('today');
  });

  it('computes the instant in dueTz, not the viewer zone', () => {
    // 10:00 in Stockholm is 09:00 in London.
    expect(dueState(task('2026-10-05', { dueTime: '08:30', dueTz: 'Europe/London' }), ctx)).toBe(
      'overdue',
    );
    expect(dueState(task('2026-10-05', { dueTime: '09:30', dueTz: 'Europe/London' }), ctx)).toBe(
      'today',
    );
    // 10:00 Stockholm is 04:00 New York: a 09:30 New York due has not.
    expect(dueState(task('2026-10-05', { dueTime: '09:30', dueTz: 'America/New_York' }), ctx)).toBe(
      'today',
    );
  });

  it('falls back to the viewer zone when dueTz is missing', () => {
    expect(dueState(task('2026-10-05', { dueTime: '09:30', dueTz: null }), ctx)).toBe('overdue');
    expect(dueState(task('2026-10-05', { dueTime: '10:30' }), ctx)).toBe('today');
  });

  it('a passed timed due is overdue even when the viewer is still on the previous day', () => {
    // Viewer in Los Angeles at 2026-10-05 17:00 local (2026-10-06 00:00Z); due 2026-10-06 08:00 Tokyo = 2026-10-05 23:00Z.
    const la = { viewerTz: 'America/Los_Angeles', nowMs: Date.UTC(2026, 9, 6, 0, 0) };
    const laCtx = { ...la, today: todayIn(la.viewerTz, la.nowMs) };
    expect(laCtx.today).toBe('2026-10-05');
    expect(dueState(task('2026-10-06', { dueTime: '08:00', dueTz: 'Asia/Tokyo' }), laCtx)).toBe(
      'overdue',
    );
  });

  it('DST start: timed overdue on 2026-03-29 in Europe/Stockholm', () => {
    const dueTz = 'Europe/Stockholm';
    const t = task('2026-03-29', { dueTime: '03:30', dueTz });
    // 03:30 CEST = 01:30Z.
    expect(dueInstant('2026-03-29', '03:30', dueTz)).toBe(Date.UTC(2026, 2, 29, 1, 30));
    const at = (ms: number) => ({ nowMs: ms, viewerTz: dueTz, today: todayIn(dueTz, ms) });
    expect(dueState(t, at(Date.UTC(2026, 2, 29, 1, 29)))).toBe('today');
    expect(dueState(t, at(Date.UTC(2026, 2, 29, 1, 31)))).toBe('overdue');
    // 02:30 does not exist that night; it resolves forward to 03:30 CEST.
    expect(dueInstant('2026-03-29', '02:30', dueTz)).toBe(Date.UTC(2026, 2, 29, 1, 30));
    // Midnight before the switch is still CET.
    expect(dueInstant('2026-03-29', '00:00', dueTz)).toBe(Date.UTC(2026, 2, 28, 23, 0));
  });

  it('DST end: timed overdue on 2026-10-25 in Europe/Stockholm', () => {
    const dueTz = 'Europe/Stockholm';
    const t = task('2026-10-25', { dueTime: '12:00', dueTz });
    // 12:00 CET = 11:00Z (it would be 10:00Z the day before, in CEST).
    expect(dueInstant('2026-10-25', '12:00', dueTz)).toBe(Date.UTC(2026, 9, 25, 11, 0));
    expect(dueInstant('2026-10-24', '12:00', dueTz)).toBe(Date.UTC(2026, 9, 24, 10, 0));
    const at = (ms: number) => ({ nowMs: ms, viewerTz: dueTz, today: todayIn(dueTz, ms) });
    expect(dueState(t, at(Date.UTC(2026, 9, 25, 10, 30)))).toBe('today');
    expect(dueState(t, at(Date.UTC(2026, 9, 25, 11, 1)))).toBe('overdue');
    // The repeated 02:30 resolves to its first (CEST) occurrence.
    expect(dueInstant('2026-10-25', '02:30', dueTz)).toBe(Date.UTC(2026, 9, 25, 0, 30));
  });

  it('rejects invalid input', () => {
    expect(() => dueInstant('2026-10-05', '25:00', 'UTC')).toThrow(RangeError);
    expect(() => dueInstant('2026-10-05', '10:00', 'Nowhere/Atlantis')).toThrow(RangeError);
    expect(() => dueState(task('2026-13-01'), ctx)).toThrow(RangeError);
  });
});
