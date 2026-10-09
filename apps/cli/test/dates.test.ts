import { describe, expect, it } from 'vitest';
import { applyDueFlags, parseTimeFlag } from '../src/dates.ts';
import { CliError } from '../src/errors.ts';

const me = {
  timezone: 'Europe/Stockholm',
  locale: 'en' as const,
  weekStart: 1 as const,
  dateFormat: 'MMM d' as const,
};
// Friday 2026-10-09, 12:00 in Stockholm.
const now = Date.UTC(2026, 9, 9, 10, 0);
const none = { dueDate: null, dueTime: null, dueTz: null, startDate: null };

describe('due flags (hard rule 5: floating dates stay strings)', () => {
  it('reads ISO dates and phrases in the user zone', () => {
    expect(applyDueFlags(none, { due: '2026-12-24' }, me, now)).toEqual({
      ...none,
      dueDate: '2026-12-24',
    });
    expect(applyDueFlags(none, { due: 'tomorrow' }, me, now)?.dueDate).toBe('2026-10-10');
    expect(applyDueFlags(none, { due: 'mon 14:00' }, me, now)).toEqual({
      dueDate: '2026-10-12',
      dueTime: '14:00',
      dueTz: 'Europe/Stockholm',
      startDate: null,
    });
  });

  it('--time alone means today; none clears', () => {
    expect(applyDueFlags(none, { time: '9:30' }, me, now)).toEqual({
      dueDate: '2026-10-09',
      dueTime: '09:30',
      dueTz: 'Europe/Stockholm',
      startDate: null,
    });
    const timed = {
      dueDate: '2026-10-12',
      dueTime: '14:00',
      dueTz: 'UTC',
      startDate: '2026-10-10',
    };
    expect(applyDueFlags(timed, { due: 'none' }, me, now)).toEqual(none);
    expect(applyDueFlags(timed, { time: 'none' }, me, now)).toEqual({
      ...timed,
      dueTime: null,
      dueTz: null,
    });
    expect(applyDueFlags(timed, {}, me, now)).toBeNull();
  });

  it('validates the start date against the due date', () => {
    expect(
      applyDueFlags(none, { due: '2026-10-20', start: '2026-10-15' }, me, now)?.startDate,
    ).toBe('2026-10-15');
    expect(() => applyDueFlags(none, { start: '2026-10-15' }, me, now)).toThrow(CliError);
    expect(() => applyDueFlags(none, { due: '2026-10-10', start: '2026-10-15' }, me, now)).toThrow(
      CliError,
    );
  });

  it('rejects what it cannot read (exit 5)', () => {
    try {
      applyDueFlags(none, { due: 'someday maybe' }, me, now);
      expect.unreachable();
    } catch (error) {
      expect((error as CliError).exitCode).toBe(5);
    }
    expect(() => parseTimeFlag('25:00')).toThrow(CliError);
    expect(parseTimeFlag('7.05')).toBe('07:05');
  });
});
